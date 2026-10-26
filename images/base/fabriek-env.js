'use strict';
// fabriek-env.js: the node twin of fabriek-env.sh. For each CALLUM_FLOW_<X> in env whose FABRIEK_<X>
// is not set, sets FABRIEK_<X> to its value, so FABRIEK_<X> wins when both are set. The old names stay
// readable for the 10-minor-release alias window; the alias-removal child drops this file.
// Returns env, so a caller can write `applyFabriekEnv(process.env)` or `applyFabriekEnv({ ...env })`.
function applyFabriekEnv(env = process.env) {
  for (const key of Object.keys(env)) {
    if (!key.startsWith('CALLUM_FLOW_')) continue;
    const name = 'FABRIEK_' + key.slice('CALLUM_FLOW_'.length);
    if (env[name] === undefined) env[name] = env[key];
  }
  return env;
}

module.exports = { applyFabriekEnv };
