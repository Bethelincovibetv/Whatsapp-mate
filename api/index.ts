import type { IncomingMessage, ServerResponse } from 'http';
import app from '../server.ts';

/**
 * Vercel Serverless Function Entry Point for Baileys WhatsApp Control Hub
 * 
 * Supports:
 * 1. Direct Express routing on Vercel serverless functions.
 * 2. Optional remote proxy if BACKEND_URL or VITE_BACKEND_URL environment variable is set.
 * 3. Guaranteed JSON responses on errors, preventing Vercel HTML error pages like
 *    "A server error has occurred" or "The page could not be found".
 */
export default async function handler(req: any, res: any) {
  // Set CORS headers for all incoming requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  // If a persistent backend URL (e.g. Cloud Run or Render) is configured in Vercel env, proxy requests to it
  const remoteBackend = process.env.BACKEND_URL || process.env.VITE_BACKEND_URL || process.env.PERSISTENT_BACKEND_URL;
  if (remoteBackend && !remoteBackend.includes('localhost') && !remoteBackend.includes('127.0.0.1')) {
    try {
      const cleanRemote = remoteBackend.replace(/\/+$/, '');
      const targetUrl = `${cleanRemote}${req.url}`;
      
      const forwardHeaders: Record<string, string> = {
        'Content-Type': req.headers['content-type'] || 'application/json',
      };
      if (req.headers['authorization']) {
        forwardHeaders['Authorization'] = req.headers['authorization'];
      }

      const fetchOptions: RequestInit = {
        method: req.method,
        headers: forwardHeaders,
      };

      if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
        fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      }

      const proxyRes = await fetch(targetUrl, fetchOptions);
      res.statusCode = proxyRes.status;
      
      const contentType = proxyRes.headers.get('content-type') || 'application/json';
      res.setHeader('Content-Type', contentType);
      
      const data = await proxyRes.text();
      res.end(data);
      return;
    } catch (proxyError: any) {
      console.warn('[Vercel API Proxy Error]', proxyError.message);
      // Fallback to local app handler
    }
  }

  // Handle locally via Express app
  try {
    return app(req, res);
  } catch (err: any) {
    console.error('[Vercel Handler Critical Error]', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: false,
        error: err.message || 'Server error occurred inside Vercel serverless function.',
      }));
    }
  }
}
