const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

exports.handler = async (event) => {
  const attrs = event?.request?.userAttributes || {};
  const userId = attrs.sub;
  const email = attrs.email;
  const fullName = attrs.name || null;

  if (!userId) throw new Error("Missing user sub");
  if (!email) throw new Error("Missing user email");

  const now = new Date().toISOString();

  await docClient.send(
    new PutCommand({
      TableName: process.env.USERS_TABLE_NAME,
      Item: {
        userId,
        email,
        fullName,
        role: "user",
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      ConditionExpression: "attribute_not_exists(userId)",
    })
  );

  return event;
};