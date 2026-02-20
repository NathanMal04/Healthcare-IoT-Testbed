#Example Python Script


import boto3
import json

#Create Lambda client
lambda_client = boto3.client('lambda')

#Invoke a Lambda function (replace with your function name and payload)
response = lambda_client.invoke(
    FunctionName='your-lambda-function',
    InvocationType='RequestResponse',  #Or 'Event' for async
    Payload=json.dumps({'key': 'value'})  #Your script input
)

#Parse response
result = json.loads(response['Payload'].read().decode())
print(result)