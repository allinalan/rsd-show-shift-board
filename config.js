// RSD Show Shift Board — deployment config.
// The anon key is designed to be public: row-level security in the database is what guards
// writes, not this key. Leave both blank and the page shows a read-only preview from seed/.
window.BOARD_CONFIG = {
  supabaseUrl:     "https://cfmkxoynjexesciriuzg.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNmbWt4b3luamV4ZXNjaXJpdXpnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5MjUxMzQsImV4cCI6MjEwNTUwMTEzNH0.EToOseTx4FK0pq75Xy6zfiDL-l_i6LMsq019wJsNx1I"
};
