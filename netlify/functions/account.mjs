/* /api/account/<action>: sign up, sign in and out, and the encrypted account document.
   The logic lives in ../lib/account-api.mjs; this file only picks the store. Production keeps
   accounts in a site-wide store; previews and branch deploys get their own, thrown away with them. */
import { getStore, getDeployStore } from '@netlify/blobs';
import { createHandler, blobsKV } from '../lib/account-api.mjs';

export default async (req, context) => {
  const opts = { name: 'accounts', consistency: 'strong' };
  const store = context.deploy && context.deploy.context === 'production' ? getStore(opts) : getDeployStore(opts);
  return createHandler({ kv: blobsKV(store) })(req, context.params.action);
};

export const config = { path: '/api/account/:action' };
