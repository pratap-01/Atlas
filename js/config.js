/* Supabase project settings. Both values are safe to publish: the anon/publishable key only
   allows what the database's row-level security policies allow (each user can reach only
   their own encrypted vault). See README → "Cloud storage setup". */
window.ATLAS_CONFIG = {
  supabaseUrl: 'https://ukogfqlmxurcydlcslnc.supabase.co',
  supabaseAnonKey: 'sb_publishable_RxgiWiCxPOasGLRWd99rhQ_cZ14kBOw', // publishable key (safe to publish; never the secret key)
};
