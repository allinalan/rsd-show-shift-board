// RSD Show Shift Board — deployment config.
// The anon key is designed to be public: row-level security in the database is what guards
// writes, not this key. Leave both blank and the page shows a read-only preview from seed/.
window.BOARD_CONFIG = {
  supabaseUrl:     "",   // e.g. https://abcdefghijklmnop.supabase.co
  supabaseAnonKey: ""    // Supabase → Project settings → API → "anon public"
};
