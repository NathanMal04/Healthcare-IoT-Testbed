"""network-controller's decisions (plan_actions), without AWS.

    python -m unittest discover -s Platform/services/lambdas/tests
"""
import importlib.util
import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-2")
os.environ.setdefault("METADATA_TABLE_NAME", "metadata")
os.environ.setdefault("VPC_ID", "vpc-1")
os.environ.setdefault("SUBNET_IDS", json.dumps(["subnet-1"]))
os.environ.setdefault("ENDPOINT_SG_ID", "sg-1")
os.environ.setdefault("ACCOUNT_POLICY", "{}")
os.environ.setdefault("EXECUTE_API_POLICY", "{}")
os.environ.setdefault("COMPUTE_ENVS", json.dumps({"fargate": "a", "fargateSpot": "b", "heavy": "c"}))

_spec = importlib.util.spec_from_file_location(
    "network_controller", Path(__file__).resolve().parents[1] / "network-controller" / "lambda_function.py")
nc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(nc)

NOW = datetime(2026, 10, 26, 12, 0, tzinfo=timezone.utc)
BASE = nc.BASE_SERVICES
HEAVY = nc.HEAVY_SERVICES
NO_DEMAND = {"any": False, "heavy": False, "waitingSessions": []}
DEMAND = {"any": True, "heavy": False, "waitingSessions": []}
ALL_DISABLED = {"fargate": "DISABLED", "fargateSpot": "DISABLED", "heavy": "DISABLED"}
FARGATE_ENABLED = {"fargate": "ENABLED", "fargateSpot": "ENABLED", "heavy": "DISABLED"}


def endpoints(services, state="available"):
    return {s: {"id": f"vpce-{s}", "state": state} for s in services}


def plan(state=None, eps=None, envs=None, demand=NO_DEMAND, now=NOW, heavy_enabled=True):
    return nc.plan_actions(state or {}, eps or {}, envs or dict(ALL_DISABLED), demand, now, 120, heavy_enabled)


class PlanActions(unittest.TestCase):
    def test_idle_and_down_does_nothing(self):
        actions = plan()
        self.assertEqual(actions["status"], "down")
        for key in ("create", "delete", "enable", "disable", "launchSessions"):
            self.assertEqual(actions[key], [])

    def test_cold_start_creates_base_endpoints_only(self):
        actions = plan(demand=DEMAND)
        self.assertEqual(actions["create"], sorted(BASE))
        self.assertEqual(actions["enable"], [])
        self.assertEqual(actions["status"], "starting")
        self.assertEqual(actions["lastDemandAt"], NOW.isoformat())

    def test_partially_available_keeps_compute_disabled(self):
        eps = {**endpoints(BASE[:3]), BASE[3]: {"id": "vpce-x", "state": "pending"}}
        actions = plan(demand=DEMAND, eps=eps)
        self.assertEqual(actions["create"], [])
        self.assertEqual(actions["enable"], [])
        self.assertEqual(actions["status"], "starting")

    def test_all_available_enables_fargate_and_launches_waiting_sessions(self):
        demand = {"any": True, "heavy": False, "waitingSessions": ["s1"]}
        actions = plan(demand=demand, eps=endpoints(BASE))
        self.assertEqual(actions["enable"], ["fargate", "fargateSpot"])
        self.assertEqual(actions["status"], "up")
        self.assertEqual(actions["launchSessions"], ["s1"])

    def test_waiting_sessions_not_launched_before_network_is_up(self):
        demand = {"any": True, "heavy": False, "waitingSessions": ["s1"]}
        self.assertEqual(plan(demand=demand)["launchSessions"], [])

    def test_stays_up_within_idle_window(self):
        state = {"lastDemandAt": (NOW - timedelta(minutes=119)).isoformat()}
        actions = plan(state=state, eps=endpoints(BASE), envs=dict(FARGATE_ENABLED))
        self.assertEqual(actions["status"], "up")
        self.assertEqual(actions["disable"], [])
        self.assertEqual(actions["delete"], [])

    def test_idle_window_over_disables_first_then_deletes(self):
        state = {"lastDemandAt": (NOW - timedelta(minutes=120)).isoformat()}
        first = plan(state=state, eps=endpoints(BASE), envs=dict(FARGATE_ENABLED))
        self.assertEqual(first["disable"], ["fargate", "fargateSpot"])
        self.assertEqual(first["delete"], [])  # not while a compute env is still enabled
        second = plan(state=state, eps=endpoints(BASE), envs=dict(ALL_DISABLED))
        self.assertEqual(sorted(second["delete"]), sorted(f"vpce-{s}" for s in BASE))
        self.assertEqual(second["status"], "stopping")

    def test_demand_during_teardown_reenables_instead_of_deleting(self):
        state = {"lastDemandAt": (NOW - timedelta(hours=3)).isoformat()}
        actions = plan(state=state, eps=endpoints(BASE), envs=dict(ALL_DISABLED), demand=DEMAND)
        self.assertEqual(actions["delete"], [])
        self.assertEqual(actions["enable"], ["fargate", "fargateSpot"])

    def test_endpoint_still_deleting_is_not_recreated_yet(self):
        eps = {**endpoints(BASE[1:]), BASE[0]: {"id": "vpce-old", "state": "deleting"}}
        actions = plan(demand=DEMAND, eps=eps)
        self.assertEqual(actions["create"], [])
        self.assertEqual(actions["delete"], [])
        self.assertEqual(actions["enable"], [])

    def test_failed_endpoint_is_deleted_for_replacement(self):
        eps = {**endpoints(BASE[1:]), BASE[0]: {"id": "vpce-bad", "state": "failed"}}
        actions = plan(demand=DEMAND, eps=eps)
        self.assertEqual(actions["delete"], ["vpce-bad"])
        self.assertEqual(actions["enable"], [])

    def test_heavy_demand_adds_ecs_endpoints_and_enables_heavy_when_ready(self):
        demand = {"any": True, "heavy": True, "waitingSessions": []}
        first = plan(demand=demand, eps=endpoints(BASE))
        self.assertEqual(first["create"], sorted(HEAVY))
        self.assertNotIn("heavy", first["enable"])
        second = plan(demand=demand, eps=endpoints(BASE + HEAVY))
        self.assertEqual(second["enable"], ["fargate", "fargateSpot", "heavy"])

    def test_heavy_not_created_when_class_is_off(self):
        demand = {"any": True, "heavy": True, "waitingSessions": []}
        self.assertEqual(plan(demand=demand, heavy_enabled=False)["create"], sorted(BASE))

    def test_heavy_only_teardown_while_base_demand_continues(self):
        state = {"heavyLastDemandAt": (NOW - timedelta(hours=3)).isoformat()}
        envs = {"fargate": "ENABLED", "fargateSpot": "ENABLED", "heavy": "ENABLED"}
        first = plan(state=state, eps=endpoints(BASE + HEAVY), envs=envs, demand=DEMAND)
        self.assertEqual(first["disable"], ["heavy"])
        self.assertEqual(first["delete"], [])
        second = plan(state=state, eps=endpoints(BASE + HEAVY), envs=dict(FARGATE_ENABLED), demand=DEMAND)
        self.assertEqual(sorted(second["delete"]), sorted(f"vpce-{s}" for s in HEAVY))
        self.assertEqual(second["disable"], [])

    def test_last_demand_is_kept_when_there_is_none_now(self):
        state = {"lastDemandAt": (NOW - timedelta(minutes=30)).isoformat()}
        self.assertEqual(plan(state=state)["lastDemandAt"], state["lastDemandAt"])


if __name__ == "__main__":
    unittest.main()
