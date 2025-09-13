// /api/download.js
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { consumeToken } from "./make-download-token";

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
});

export default async function handler(req, res) {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: "missing token" });

    const rec = consumeToken(token);
    if (!rec) return res.status(403).json({ error: "invalid or expired token" });

    const cmd = new GetObjectCommand({
      Bucket: process.env.AWS_BUCKET,
      Key: process.env.INSTALLER_KEY, // e.g. "releases/TrueTrend_Universal_Chrome_Extension_v4.3.3.5_with_QuickStart.zip"
    });
    const signed = await getSignedUrl(s3, cmd, { expiresIn: 60 });

    res.writeHead(302, { Location: signed });
    res.end();
  } catch (err) {
    console.error("download error:", err);
    res.status(500).json({ error: "download failed" });
  }
}
