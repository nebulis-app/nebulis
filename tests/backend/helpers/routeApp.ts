import express, { type Router } from 'express';
import { apiEnvelope } from '../../../server/middleware/apiEnvelope';

/**
 * Mounts a real router behind the real API envelope, the way the server does, minus the
 * login step. Who is calling comes from headers, so one app can show every side of a guard:
 *   x-test-role: 'admin' (default) | 'viewer'
 *   x-test-user: the user id (default 'test-user'); 'none' means nobody is signed in
 *   x-test-via:  'api-key' | 'device' to arrive on an API key or a paired-device token
 */
export function routeApp(router: Router, mountAt = '/') {
  const app = express();
  app.use(express.json());
  app.use(apiEnvelope);
  app.use((req, _res, next) => {
    req.id = 'test';
    const user = req.header('x-test-user');
    req.userId = user === 'none' ? undefined : (user ?? 'test-user');
    req.username = req.userId ? `name-of-${req.userId}` : undefined;
    const role = req.header('x-test-role');
    req.userRole = role === 'viewer' || role === 'admin' ? role : 'admin';
    const via = req.header('x-test-via');
    req.viaApiKey = via === 'api-key';
    req.viaDeviceToken = via === 'device';
    next();
  });
  app.use(mountAt, router);
  return app;
}
