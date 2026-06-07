#!/bin/bash
# Poultry DSS Database Backup Script
# Creates a daily backup of the SQLite database and retains the last 7 days.

set -e

BACKUP_DIR="/home/kelvitz/AntigravityProjects/PoultryProject/data/backups"
DB_FILE="/home/kelvitz/AntigravityProjects/PoultryProject/data/poultry.db"
DATE=$(date +%Y-%m-%d)
BACKUP_FILE="$BACKUP_DIR/poultry_$DATE.db"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Check if database exists
if [ -f "$DB_FILE" ]; then
    # Perform a safe backup using sqlite3 online backup API if possible, else copy
    # .backup locks the db briefly to ensure consistency
    sqlite3 "$DB_FILE" ".backup '$BACKUP_FILE'"
    echo "Backup created at $BACKUP_FILE"
    
    # Prune backups older than 7 days
    find "$BACKUP_DIR" -name "poultry_*.db" -type f -mtime +7 -delete
    echo "Old backups pruned."
else
    echo "Database file not found at $DB_FILE!"
    exit 1
fi
