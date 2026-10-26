"""Creates the VPC's interface endpoints while there is work, and deletes them
after an idle period.

Each interface endpoint costs about $0.01 an hour, around $51 a month for all
seven if they were always on. Run jobs and notebook sessions need them (image
pulls, logs, the manifest API; ecs* for Heavy instances), nothing else does.
So they exist only while a run or session is active, plus IDLE_MINUTES after
the last one finished; the first run after a quiet period waits 2-3 minutes
for them.

Safety rule: a Batch compute environment is ENABLED only while every endpoint
it needs is available. Jobs submitted while it is DISABLED wait in RUNNABLE,
so runs-api submits exactly as before. Teardown disables the compute
environments first and deletes endpoints only on a later tick, after checking
demand again.

Invoked every minute by EventBridge, and asynchronously by runs-api and
sessions-api when work starts (so it doesn't wait for the next tick). Once
the network is up it asks sessions-api to launch sessions that were waiting
for it. Endpoints are found by tag (ManagedBy=network-controller), so AWS is
the source of truth; NETWORK/STATE only remembers when work was last seen.
"""
import json
import os
import time
import uuid
import boto3
from datetime import datetime, timedelta, timezone
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

ec2 = boto3.client("ec2")
batch = boto3.client("batch")
lambda_client = boto3.client("lambda")
dynamodb = boto3.resource("dynamodb")

TABLE = os.environ["METADATA_TABLE_NAME"]
REGION = os.environ.get("AWS_REGION", "us-east-2")
VPC_ID = os.environ["VPC_ID"]
SUBNET_IDS = json.loads(os.environ["SUBNET_IDS"])
ENDPOINT_SG_ID = os.environ["ENDPOINT_SG_ID"]
IDLE_MINUTES = int(os.environ.get("IDLE_MINUTES", "120"))
ACCOUNT_POLICY = os.environ["ACCOUNT_POLICY"]
EXECUTE_API_POLICY = os.environ["EXECUTE_API_POLICY"]
COMPUTE_ENVS = json.loads(os.environ["COMPUTE_ENVS"])  # {"fargate": arn, "fargateSpot": arn, "heavy": arn?}
HEAVY_ENABLED = os.environ.get("HEAVY_ENABLED", "false") == "true"
SESSIONS_API_FUNCTION = os.environ.get("SESSIONS_API_FUNCTION", "")

TAG_KEY, TAG_VALUE = "ManagedBy", "network-controller"
BASE_SERVICES = ("ecr.api", "ecr.dkr", "logs", "execute-api")
HEAVY_SERVICES = ("ecs", "ecs-agent", "ecs-telemetry")
# Which endpoints each compute environment needs before it may be enabled.
NEEDS = {"fargate": BASE_SERVICES, "fargateSpot": BASE_SERVICES, "heavy": BASE_SERVICES + HEAVY_SERVICES}

RUN_TERMINAL = {"completed", "failed", "cancelled", "stopped"}
SESSION_ACTIVE = {"waiting", "launching", "running", "stopping"}
LOCK_SECONDS = 50


def handler(event, context):
    table = dynamodb.Table(TABLE)
    owner = str(uuid.uuid4())
    if not _lock(table, owner):
        return {"skipped": "another invocation is running"}
    try:
        now = datetime.now(timezone.utc)
        demand = _demand(table)
        state = table.get_item(Key={"pk": "NETWORK", "sk": "STATE"}).get("Item") or {}
        endpoints = _endpoints()
        envs = _compute_env_states()
        actions = plan_actions(state, endpoints, envs, demand, now, IDLE_MINUTES, HEAVY_ENABLED)
        _apply(actions, endpoints, now)
        _save_state(table, actions, now)
        summary = {k: v for k, v in actions.items() if v and k not in ("lastDemandAt", "heavyLastDemandAt")}
        if any(actions[k] for k in ("create", "delete", "enable", "disable", "launchSessions")):
            print(json.dumps({"event": "network_reconciled", **summary}, default=str))
        return summary
    finally:
        _unlock(table, owner)


# --- Decision (pure; unit-tested) --------------------------------------------------

def plan_actions(state, endpoints, envs, demand, now, idle_minutes, heavy_enabled):
    """Decides what to change.

    state      NETWORK/STATE: lastDemandAt, heavyLastDemandAt (ISO strings)
    endpoints  {service: {"id": ..., "state": "pending" | "available" | "deleting" | "failed" | ...}}
    envs       {compute env key: "ENABLED" | "DISABLED"}
    demand     {"any": bool, "heavy": bool, "waitingSessions": [session ids]}
    """
    idle = timedelta(minutes=idle_minutes)
    last = now if demand["any"] else _parse(state.get("lastDemandAt"))
    heavy_last = now if demand["heavy"] else _parse(state.get("heavyLastDemandAt"))

    want_base = last is not None and now - last < idle
    want_heavy = heavy_enabled and want_base and heavy_last is not None and now - heavy_last < idle
    wanted = set(BASE_SERVICES if want_base else ()) | set(HEAVY_SERVICES if want_heavy else ())

    # An endpoint that is still being deleted blocks a new one for the same
    # service (their private DNS names would clash); it is created next tick.
    create = sorted(s for s in wanted if s not in endpoints)
    available = {s for s, e in endpoints.items() if e["state"] == "available"}
    # A failed or rejected endpoint is replaced: deleted now, created again
    # on a later tick once it's gone.
    broken = {s for s, e in endpoints.items() if e["state"] in ("failed", "rejected", "expired")}

    ready = {key: set(services) <= available and set(services) <= wanted for key, services in NEEDS.items()}
    enable = sorted(k for k in envs if ready.get(k) and envs[k] == "DISABLED")
    disable = sorted(k for k in envs if not ready.get(k) and envs[k] == "ENABLED")

    # Endpoints are deleted only once every compute environment that needs
    # them is already DISABLED (normally disabled on an earlier tick), so no
    # job can be placed without its network.
    delete = []
    for service, endpoint in sorted(endpoints.items()):
        if endpoint["state"] == "deleting":
            continue
        if service in broken or service not in wanted:
            dependents = [k for k, services in NEEDS.items() if service in services and k in envs]
            if service in broken or all(envs[k] == "DISABLED" for k in dependents):
                delete.append(endpoint["id"])

    base_up = ready["fargate"]
    if base_up:
        status = "up"
    elif want_base:
        status = "starting"
    elif endpoints:
        status = "stopping"
    else:
        status = "down"

    return {
        "status": status,
        "lastDemandAt": last.isoformat() if last else None,
        "heavyLastDemandAt": heavy_last.isoformat() if heavy_last else None,
        "create": create,
        "delete": delete,
        "enable": enable,
        "disable": disable,
        "launchSessions": list(demand.get("waitingSessions") or []) if base_up else [],
    }


def _parse(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


# --- Reads -----------------------------------------------------------------------------

def _demand(table):
    """Active runs and sessions. Terminal rows left in ACTIVE#* (removed by
    runs-events / sessions-events and the watchdog) don't count."""
    run_ids = [r["sk"][len("RUN#"):] for r in _query(table, "ACTIVE#RUNS", "RUN#")]
    runs = _batch_get(table, [{"pk": f"RUN#{i}", "sk": "METADATA"} for i in run_ids])
    runs = [r for r in runs if r.get("status") not in RUN_TERMINAL]

    session_ids = [r["sk"][len("SESSION#"):] for r in _query(table, "ACTIVE#SESSIONS", "SESSION#")]
    sessions = _batch_get(table, [{"pk": f"SESSION#{i}", "sk": "METADATA"} for i in session_ids])
    sessions = [s for s in sessions if s.get("status") in SESSION_ACTIVE]

    return {
        "any": bool(runs or sessions),
        "heavy": any(r.get("class") == "heavy" for r in runs),
        "waitingSessions": sorted(s["sessionId"] for s in sessions if s.get("status") == "waiting"),
    }


def _endpoints():
    found = {}
    kwargs = {"Filters": [{"Name": "vpc-id", "Values": [VPC_ID]},
                          {"Name": f"tag:{TAG_KEY}", "Values": [TAG_VALUE]}]}
    while True:
        page = ec2.describe_vpc_endpoints(**kwargs)
        for endpoint in page.get("VpcEndpoints", []):
            state = endpoint["State"].lower()
            if state == "deleted":
                continue
            service = endpoint["ServiceName"].rsplit(f"{REGION}.", 1)[-1]
            current = found.get(service)
            # Prefer an available endpoint if a duplicate ever exists.
            if current is None or (current["state"] != "available" and state == "available"):
                found[service] = {"id": endpoint["VpcEndpointId"], "state": state}
        if not page.get("NextToken"):
            return found
        kwargs["NextToken"] = page["NextToken"]


def _compute_env_states():
    arns = {arn: key for key, arn in COMPUTE_ENVS.items() if arn}
    if not arns:
        return {}
    described = batch.describe_compute_environments(computeEnvironments=list(arns)).get("computeEnvironments", [])
    return {arns[ce["computeEnvironmentArn"]]: ce["state"] for ce in described if ce["computeEnvironmentArn"] in arns}


# --- Changes ----------------------------------------------------------------------------

def _apply(actions, endpoints, now):
    for key in actions["disable"]:
        _set_compute_env(key, "DISABLED")
    for endpoint_id in actions["delete"]:
        try:
            ec2.delete_vpc_endpoints(VpcEndpointIds=[endpoint_id])
        except ClientError as e:
            print(json.dumps({"event": "endpoint_delete_failed", "endpointId": endpoint_id, "error": str(e)}))
    for service in actions["create"]:
        _create_endpoint(service, now)
    for key in actions["enable"]:
        _set_compute_env(key, "ENABLED")
    for session_id in actions["launchSessions"]:
        if SESSIONS_API_FUNCTION:
            lambda_client.invoke(FunctionName=SESSIONS_API_FUNCTION, InvocationType="Event",
                                 Payload=json.dumps({"action": "launch", "sessionId": session_id}).encode())


def _create_endpoint(service, now):
    policy = EXECUTE_API_POLICY if service == "execute-api" else ACCOUNT_POLICY
    try:
        ec2.create_vpc_endpoint(
            VpcEndpointType="Interface",
            VpcId=VPC_ID,
            ServiceName=f"com.amazonaws.{REGION}.{service}",
            SubnetIds=SUBNET_IDS,
            SecurityGroupIds=[ENDPOINT_SG_ID],
            PrivateDnsEnabled=True,
            PolicyDocument=policy,
            # Same token within a minute, so a retried call can't make a duplicate.
            ClientToken=f"{service}-{now.strftime('%Y%m%d%H%M')}",
            TagSpecifications=[{"ResourceType": "vpc-endpoint", "Tags": [
                {"Key": TAG_KEY, "Value": TAG_VALUE},
                {"Key": "Name", "Value": f"{VPC_ID}-{service}"},
            ]}],
        )
    except ClientError as e:
        # e.g. a clashing private DNS name while an old endpoint is still
        # being deleted; the next tick tries again.
        print(json.dumps({"event": "endpoint_create_failed", "service": service, "error": str(e)}))


def _set_compute_env(key, state):
    try:
        batch.update_compute_environment(computeEnvironment=COMPUTE_ENVS[key], state=state)
    except ClientError as e:
        print(json.dumps({"event": "compute_env_update_failed", "computeEnv": key, "state": state, "error": str(e)}))


def _save_state(table, actions, now):
    item = {"pk": "NETWORK", "sk": "STATE", "entity": "network-state", "status": actions["status"],
            "updatedAt": now.isoformat()}
    for field in ("lastDemandAt", "heavyLastDemandAt"):
        if actions[field]:
            item[field] = actions[field]
    table.put_item(Item=item)


# --- Lock: one reconcile at a time (schedule + wake-ups can overlap) -----------------

def _lock(table, owner):
    now = int(time.time())
    try:
        table.put_item(
            Item={"pk": "NETWORK", "sk": "LOCK", "owner": owner, "expiresAt": now + LOCK_SECONDS},
            ConditionExpression="attribute_not_exists(pk) OR expiresAt < :now",
            ExpressionAttributeValues={":now": now},
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def _unlock(table, owner):
    try:
        table.delete_item(Key={"pk": "NETWORK", "sk": "LOCK"}, ConditionExpression="#o = :o",
                          ExpressionAttributeNames={"#o": "owner"}, ExpressionAttributeValues={":o": owner})
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


# --- Helpers ---------------------------------------------------------------------------

def _query(table, pk, prefix):
    items, kwargs = [], {"KeyConditionExpression": Key("pk").eq(pk) & Key("sk").begins_with(prefix)}
    while True:
        page = table.query(**kwargs)
        items += page.get("Items", [])
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _batch_get(table, keys):
    items = []
    for start in range(0, len(keys), 100):
        request = {TABLE: {"Keys": keys[start:start + 100]}}
        while request:
            result = dynamodb.batch_get_item(RequestItems=request)
            items += result.get("Responses", {}).get(TABLE, [])
            request = result.get("UnprocessedKeys") or None
    return items
