# Self-hosting

How to run your own copy of the testbed in your own AWS account, on your own domain. You end up with the
same platform as the original deployment: the web app at `https://<your domain>`, its API, storage, script
builds, batch runs and notebook sessions.

Deploying takes four steps, all run by `Platform/scripts/deploy.sh`:

| Step | What it does | How often |
|---|---|---|
| `bootstrap` | Creates the Terraform state bucket and (optionally) the role GitHub Actions deploys with | Once per account |
| `infra` | Applies the Terraform in `Platform/infra/envs/dev`, including the HTTPS certificate | Every infrastructure change |
| `images` | Builds the platform container images and records them | Once, then when `Platform/services/containers` changes |
| `web` | Builds the web app with your settings and publishes it | Every web change |

After the first deploy you can let GitHub Actions in your fork do `infra`, `images` and `web` on every push
to `main`, as the original deployment does.

## 1. Before you start

You need:

- **An AWS account** where you can create IAM roles and policies (the first deploy runs with your own
  credentials, for example an `AdministratorAccess` SSO role).
- **A domain** whose DNS you control, for example `testbed.example.com`. It can be a subdomain. If its zone
  is in Route 53, Terraform creates the DNS records for you; any other DNS provider works too, and you add
  three or four records by hand.
- **Tools:** Terraform ≥ 1.10, AWS CLI v2, Node.js 20, Python 3 with `boto3`, and Docker (only for the
  `images` step). The devcontainer (README, "Development Environment") has all of these except Docker. Run
  `images` on a machine that has Docker, or let GitHub Actions do it.
- **Optional:** a GitHub fork of this repository, and the `gh` CLI, for CI deploys.

**Costs.** Most of the platform costs nothing while idle (Lambda, API Gateway, DynamoDB on demand, Batch,
CodeBuild, Fargate). You do pay for storage, for the runs and builds users start (held against their
monthly budgets), and for the run network's VPC interface endpoints. The endpoints are created when runs or
notebook sessions need them and removed `network_idle_minutes` after the last one finishes (see
`Platform/infra/envs/dev/network.tf`). Set `enable_heavy_class = false` if you don't need the EC2 run class.

**Quotas.** New AWS accounts start with low Fargate and Fargate Spot vCPU quotas. Ask for increases
(Service Quotas → AWS Fargate) before running large jobs.

## 2. AWS credentials

Use any credentials the AWS CLI understands. In the devcontainer, replace `.devcontainer/aws/config` with
your own profile (start from `.devcontainer/aws/config.example`), then:

```bash
aws sso login                 # if you use IAM Identity Center
aws sts get-caller-identity   # must show your account
```

The devcontainer sets `AWS_PROFILE=Healthcare-IoT-Dev`. Name your profile the same, or set `AWS_PROFILE`
on the host before opening the container. Pick one region for everything, e.g. `us-east-2`. The CloudFront
certificate is always created in `us-east-1`; Terraform handles that.

## 3. Bootstrap the account

```bash
cp Platform/infra/bootstrap/terraform.tfvars.example Platform/infra/bootstrap/terraform.tfvars
# edit it: name, state_bucket_name, aws_region, github_repo (or remove it to skip CI)
Platform/scripts/deploy.sh bootstrap
```

| Variable | Notes |
|---|---|
| `name` | Prefix for every resource name, 3–29 lowercase letters, digits and hyphens, e.g. `acme-testbed-dev`. S3 bucket names are built from it, so it must be **globally unique**. Use the same value in step 4. |
| `state_bucket_name` | Bucket for Terraform state, e.g. `acme-testbed-tf-state`. Globally unique. |
| `github_repo` | Your fork, `owner/repo`. The deploy role trusts every workflow in it. Leave unset to deploy only from your machine. |
| `create_oidc_provider` | Set to `false` if the account already has the `token.actions.githubusercontent.com` identity provider (IAM → Identity providers); an account can have only one. |
| `route53_zone_id` | Set if you use Route 53 in step 4, so the deploy role may write records in that zone. |

This creates:
- the state bucket (versioned, encrypted, private);
- with `github_repo`, the GitHub OIDC identity provider and the role `<name>-github-deploy`, with the policies
  `<name>-deploy-core`, `-runs`, `-sessions` (and `-dns` with Route 53). They come from
  `Platform/infra/bootstrap/policies/`, which are copies of the original deployment's deploy policies;
- `Platform/infra/envs/dev/backend.hcl`, which tells Terraform where the state is.

It then prints the `gh` commands that configure your fork (section 7).

The bootstrap keeps its own state in `Platform/infra/bootstrap/terraform.tfstate` (git-ignored), because the
state bucket can't hold the state of the configuration that creates it. Keep that file. To keep it in the
bucket instead, add `backend "s3" {}` to `bootstrap/versions.tf` and run
`terraform -chdir=Platform/infra/bootstrap init -migrate-state -backend-config=../envs/dev/backend.hcl -backend-config=key=bootstrap/terraform.tfstate`.

## 4. Configure the deployment

```bash
cp Platform/infra/envs/dev/terraform.tfvars.example Platform/infra/envs/dev/terraform.tfvars
```

| Variable | Required | Notes |
|---|---|---|
| `name` | yes | The same as in the bootstrap. |
| `domain_name` | yes | The site's hostname, e.g. `testbed.example.com`. The app works **only** on this origin: the API and uploads allow just `https://<domain_name>` (README, "Canonical Host"). |
| `aws_region` | no | Default `us-east-2`. The same as in the bootstrap. |
| `include_www` | no | Default `true`: `www.<domain_name>` also works and redirects to `domain_name`. Set `false` for a subdomain like `testbed.example.com`, where `www.` makes little sense. |
| `route53_zone_id` | no | Your domain's Route 53 hosted zone ID. Terraform then validates the certificate and creates the site's records. |
| `brand_name` | no | Product name in the web app and the sign-up email. Default `Vzoniq`. |
| `extra_allowed_origins` | no | Other origins allowed to upload straight to S3. Default `["http://localhost:3000"]` (local development). |
| `enable_heavy_class`, `default_monthly_limit`, `network_idle_minutes` | no | See `variables.tf`. |

## 5. Deploy

```bash
Platform/scripts/deploy.sh infra
```

Terraform shows each plan and asks before applying (`DEPLOY_AUTO_APPROVE=true` skips that). The first apply
creates several hundred resources and takes 10–20 minutes; CloudFront is the slow part.

**With Route 53** (`route53_zone_id` set), this needs nothing else: the certificate's validation records
and the site's A/AAAA alias records are created for you.

**With another DNS provider**, the script works in two stages:
1. It creates the certificate first and prints its validation records, for example:
   ```
   CNAME  _5535e8d6….testbed.example.com.  ->  _fed92963….acm-validations.aws.
   ```
   Add each one at your DNS provider. The script waits until ACM shows the certificate as issued, usually a
   few minutes after the records resolve. Keep the records: ACM needs them to renew the certificate.
2. It applies everything else, then prints the CloudFront hostname (`dxxxxxxxxxxxxx.cloudfront.net`). Point
   `domain_name` at it, using an ALIAS/ANAME record at a zone apex (`example.com`) or a CNAME otherwise
   (`testbed.example.com`), plus a CNAME for `www.<domain_name>` if `include_www` is on.

The records are also available later from `terraform output acm_validation_records` and
`terraform output cloudfront_domain_name` in `Platform/infra/envs/dev`.

Then build the platform images and publish the web app:

```bash
Platform/scripts/deploy.sh images   # needs Docker; scripts and environments can't build until this has run once
Platform/scripts/deploy.sh web
```

`deploy.sh all` runs `infra`, `images` and `web` in order.

## 6. First sign-in

Open `https://<domain_name>/signup`, register, and enter the emailed code. Every user starts with a monthly
budget of `default_monthly_limit` (USD 25) for runs and builds, with the Heavy class off. To change a user's
budget (their user ID is the Cognito `sub`: Cognito → User pools → `<name>-users` → Users):

```bash
python3 Platform/scripts/set_budget.py \
  --table "$(terraform -chdir=Platform/infra/envs/dev output -raw metadata_table_name)" \
  --user-id <cognito sub> --monthly-limit 100 --heavy on
```

**Email.** Cognito sends verification emails from its default sender, `no-reply@verificationemail.com`,
which is limited to about 50 emails a day per account. For more, or to send from your own domain, set up
Amazon SES and switch the user pool's email configuration to it (`Platform/infra/modules/cognito`).

## 7. GitHub Actions (optional)

With `github_repo` set in the bootstrap, your fork can deploy itself. The workflows in `.github/workflows/`
deploy on pushes to `main` (infrastructure, images, web) and check pull requests (Terraform plan, frontend
build). Under the fork's **Settings → Secrets and variables → Actions** (or with the `gh` commands
`deploy.sh bootstrap` printed), set:

**Secrets**

| Secret | Value |
|---|---|
| `AWS_ROLE_ARN` | `terraform -chdir=Platform/infra/bootstrap output -raw deploy_role_arn` |
| `AWS_REGION` | Your region, e.g. `us-east-2` |

**Variables**

| Variable | Required | Value |
|---|---|---|
| `TF_STATE_BUCKET` | yes | The state bucket |
| `TF_NAME` | yes | `name` |
| `DOMAIN_NAME` | yes | `domain_name` |
| `TF_USE_LOCKFILE` | no | `true` (recommended: stops two deploys writing the state at once) |
| `ROUTE53_ZONE_ID` | no | `route53_zone_id` |
| `BRAND_NAME` | no | `brand_name` |

CI doesn't read `terraform.tfvars` or `backend.hcl`, which aren't committed; keep these variables and your
local files in agreement. Other settings you changed in `terraform.tfvars` (such as `include_www` or
`enable_heavy_class`) need to be passed the same way: add a `TF_VAR_<variable>` entry to the `env` block of
`deploy-infra.yml` and `terraform-pr-check.yml`.

Do the first deploy from your machine (section 5), then let CI take over. The deploy role's policies are
the ones the original deployment's CI uses for its updates; a from-scratch apply through CI hasn't been
tested against them.

**If you change a deploy policy** in the console, or need a new permission, edit the template in
`Platform/infra/bootstrap/policies/` and re-apply the bootstrap. `check_deploy_policy_drift.py` compares
the templates with an account's live policies:

```bash
python3 Platform/scripts/check_deploy_policy_drift.py --name <name> --state-bucket <state bucket>
```

## 8. Staying up to date

Pull changes from the upstream repository into your fork as usual. Your deployment's values live only in
the git-ignored `terraform.tfvars` and `backend.hcl` and in GitHub's settings, so they don't conflict with
upstream changes. Read the plan before applying: a new feature may need new resources or new deploy-role
permissions (in `bootstrap/policies/`).

## 9. Tearing it down

Some resources are protected against accidental deletion, so a teardown takes a few manual steps:

```bash
cd Platform/infra/envs/dev
NAME=<name>

# The buckets must be empty, and the ECR repositories have images.
aws s3 rm "s3://$NAME-data-lake" --recursive
aws s3 rm "s3://$NAME-web" --recursive
for repo in $(aws ecr describe-repositories --query "repositories[?starts_with(repositoryName, '$NAME-')].repositoryName" --output text); do
  aws ecr delete-repository --repository-name "$repo" --force
done

# The DynamoDB tables have prevent_destroy and deletion protection: take them
# out of Terraform, destroy the rest, then delete them yourself.
terraform state rm module.metadata_table module.users_table
terraform destroy
for t in "$NAME-metadata" "$NAME-users"; do
  aws dynamodb update-table --table-name "$t" --no-deletion-protection-enabled
  aws dynamodb delete-table --table-name "$t"
done
```

Remove the DNS records you added by hand. Last, the bootstrap. Its state bucket has `prevent_destroy`, so take
it out of the bootstrap's state, destroy the rest (the GitHub role, its policies and the identity provider),
then empty the bucket, including old object versions, and delete it in the S3 console:

```bash
cd Platform/infra/bootstrap
terraform state rm aws_s3_bucket.state aws_s3_bucket_versioning.state \
  aws_s3_bucket_server_side_encryption_configuration.state aws_s3_bucket_public_access_block.state
terraform destroy
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| `BucketAlreadyExists` on the first apply | `name` (or `state_bucket_name`) is taken by another account. Pick another. |
| The site loads, but every API call fails with a CORS error | The page isn't served from `https://<domain_name>` exactly, or the web app was built before `infra` finished. Re-run `deploy.sh web`. |
| `deploy.sh infra` keeps waiting for the certificate | The validation CNAMEs aren't resolving yet. Check them with `dig CNAME <record name>`; some DNS providers append the zone name, so enter only the part before your domain. |
| CloudFront fails with `InvalidViewerCertificate` | The certificate isn't issued yet (another DNS provider without the two-stage `deploy.sh infra`). Wait for it, then apply again. |
| Script builds fail with "Environment platform-base has no ready version yet" | `deploy.sh images` hasn't run yet. |
| Runs wait in `RUNNABLE` | Fargate vCPU quota. Request an increase. |
| CI fails at "Check repository variables" | Set the variables listed in the error (section 7). |
