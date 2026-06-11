{
    "$schema": "node_modules/wrangler/config-schema.json",
    "name": "one-balance",
    "main": "src/index.ts",
    "compatibility_date": "2025-06-20",
    "ai": {
        "binding": "AI"
    },
    "d1_databases": [
        {
            "binding": "DB",
            "database_name": "one-balance",
            "database_id": "my-database-id",
            "migrations_dir": "src/service/d1/migrations"
        }
    ],
    "vars": {
        "AUTH_KEY": "my-auth-key",
        "KEY_MANAGER_TOKEN": "my-key-manager-token",
        "AI_GATEWAY": "one-balance"
    },
    "observability": {
        "enabled": true
    }
}