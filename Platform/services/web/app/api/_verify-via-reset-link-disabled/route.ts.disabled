import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import client from "@/app/lib/mongodb";

export async function POST(req: Request) {
  try {
    const { token } = await req.json();

    if (!token) {
      return NextResponse.json({ error: "Token is required" }, { status: 400 });
    }

    const db = client.db();

    const verification = await db.collection("verification").findOne({
      identifier: `reset-password:${token}`,
      expiresAt: { $gt: new Date() },
    });

    if (!verification) {
      return NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 400 }
      );
    }

    const userId = verification.value;

    await db
      .collection("user")
      .updateOne(
        { _id: new ObjectId(userId) },
        { $set: { emailVerified: true } }
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("verify-via-reset-link error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
