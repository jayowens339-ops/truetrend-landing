// /api/installer.js  (Vercel serverless function)
export default function handler(req, res) {
  // Optional: you can read req.query.session_id if you ever want to verify it
  res.writeHead(302, { Location: '/installer.html' }); // or 307 if you prefer
  res.end('Redirecting to installer…');
}
