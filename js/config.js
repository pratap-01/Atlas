/* Supabase project settings. Both values are safe to publish: the anon/publishable key only
   allows what the database's row-level security policies allow (each user can reach only
   their own encrypted vault). See README → "Cloud storage setup". */
window.ATLAS_CONFIG = {
  supabaseUrl: '',      // e.g. 'https://abcdefghijklmnop.supabase.co'
  supabaseAnonKey: '',  // Project Settings → API Keys → anon / publishable key
};
