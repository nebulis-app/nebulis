/**
 * Connected devices — paired TVs and other long-lived sessions a user owns.
 * All endpoints require authentication; users only see/modify their own devices.
 */
import { Router, Request, Response } from 'express';
import {
  listDevicesForUser,
  revokeDeviceForUser,
  renameDeviceForUser,
  adminListAllDevices,
  adminRevokeDevice,
} from '../lib/devicePairing.js';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  if (!req.userId) {
    res.apiError(401, 'AUTH_REQUIRED', 'Authentication required.');
    return;
  }
  res.apiSuccess(listDevicesForUser(req.userId));
});

// Admin-only: every device across every user. Routed under /admin/* so it
// sits clear of /devices/:id and signals privilege at the URL.
router.get('/admin/all', (req: Request, res: Response) => {
  if (!req.userId) {
    res.apiError(401, 'AUTH_REQUIRED', 'Authentication required.');
    return;
  }
  if (req.userRole !== 'admin') {
    res.apiError(403, 'FORBIDDEN', 'Admin access required.');
    return;
  }
  res.apiSuccess(adminListAllDevices());
});

router.delete('/admin/:id', (req: Request, res: Response) => {
  if (!req.userId) {
    res.apiError(401, 'AUTH_REQUIRED', 'Authentication required.');
    return;
  }
  if (req.userRole !== 'admin') {
    res.apiError(403, 'FORBIDDEN', 'Admin access required.');
    return;
  }
  const id = typeof req.params.id === 'string' ? req.params.id : '';
  const ok = adminRevokeDevice(id);
  if (!ok) {
    res.apiError(404, 'DEVICE_NOT_FOUND', 'No matching device to revoke.');
    return;
  }
  res.apiSuccess({ revoked: true });
});

router.delete('/:id', (req: Request, res: Response) => {
  if (!req.userId) {
    res.apiError(401, 'AUTH_REQUIRED', 'Authentication required.');
    return;
  }
  const id = typeof req.params.id === 'string' ? req.params.id : '';
  const ok = revokeDeviceForUser(req.userId, id);
  if (!ok) {
    res.apiError(404, 'DEVICE_NOT_FOUND', 'No matching device to revoke.');
    return;
  }
  res.apiSuccess({ revoked: true });
});

router.patch('/:id', (req: Request, res: Response) => {
  if (!req.userId) {
    res.apiError(401, 'AUTH_REQUIRED', 'Authentication required.');
    return;
  }
  const id = typeof req.params.id === 'string' ? req.params.id : '';
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  const ok = renameDeviceForUser(req.userId, id, name);
  if (!ok) {
    res.apiError(400, 'INVALID', 'Could not rename device.');
    return;
  }
  res.apiSuccess({ renamed: true });
});

export const devicesRouter = router;
