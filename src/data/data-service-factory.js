(function exposeDataServiceFactory(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ReactivationData = Object.assign(root.ReactivationData || {}, api);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDataServiceFactory(root) {
  'use strict';

  function normalizeDataMode(value) { return value === 'supabase' ? 'supabase' : 'local'; }

  function createConfiguredDataService(options) {
    const config = options || {};
    const mode = normalizeDataMode(config.mode || (root.REACTIVATION_DATA_CONFIG && root.REACTIVATION_DATA_CONFIG.mode));
    if (mode === 'supabase') {
      if (typeof config.createSupabase !== 'function') throw new Error('SUPABASE_DATA_SERVICE_FACTORY_REQUIRED');
      return config.createSupabase();
    }
    if (typeof config.createLocal !== 'function') throw new Error('LOCAL_DATA_SERVICE_FACTORY_REQUIRED');
    return config.createLocal();
  }

  return { normalizeDataMode, createConfiguredDataService };
});
