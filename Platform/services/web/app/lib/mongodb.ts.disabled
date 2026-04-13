import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI!;

if (!uri) {
  throw new Error("Please add MONGODB_URI to your environment variables");
}

let client: MongoClient;

declare global {
  var _mongoClient: MongoClient | undefined;
}

if (process.env.NODE_ENV === "development") {
  if (!global._mongoClient) {
    global._mongoClient = new MongoClient(uri);
  }
  client = global._mongoClient;
} else {
  client = new MongoClient(uri);
}

export default client;
