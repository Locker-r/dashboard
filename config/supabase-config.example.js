(function configureSupabase(root) {
  'use strict';

  root.REACTIVATION_SUPABASE_CONFIG = Object.freeze({
    projectUrl: 'https://YOUR_PROJECT_REF.supabase.co',
    publishableKey: 'YOUR_SUPABASE_PUBLISHABLE_KEY'
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
