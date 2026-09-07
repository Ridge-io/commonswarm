import json,sys
d=json.load(sys.stdin)
for k,v in [("API","API_URL"),("ANON","ANON_KEY"),("DB","DB_URL"),("SR","SERVICE_ROLE_KEY")]:
    print(f"{k}='{d[v]}'")
