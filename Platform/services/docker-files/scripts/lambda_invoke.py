import boto3
import json

#FIX: Specify region explicitly rather than relying on environment config,
#which may not be set inside the container.
lambda_client = boto3.client('lambda', region_name='us-east-1')

response = lambda_client.invoke(
    FunctionName='your-lambda-function',
    InvocationType='RequestResponse',  #Or 'Event' for async
    Payload=json.dumps({'key': 'value'})
)

#FIX: Check StatusCode before reading the payload. A 200 means the invoke
#request itself was accepted; anything else (e.g. 400, 429) is a client/
#throttling error that would produce non-JSON output and crash json.loads.
status = response['StatusCode']
if status != 200:
    raise RuntimeError(f'Lambda invoke failed with status {status}')

payload = json.loads(response['Payload'].read().decode())

#FIX: Check for FunctionError. When the Lambda function itself throws an
#exception, AWS still returns HTTP 200 but sets this key to 'Handled' or
#'Unhandled'. Without this check, execution errors are silently treated as
#successful results.
if response.get('FunctionError'):
    raise RuntimeError(f"Lambda function error ({response['FunctionError']}): {payload}")

print(payload)
