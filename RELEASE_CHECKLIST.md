# Release Checklist

Před každým deployem na produkci:

1. bash scripts/test-gate.sh → PASS
2. git status — žádné uncommitted změny
3. systemctl restart integrity-x402.service
4. sleep 3
5. curl -s http://127.0.0.1:3402/health → 200
6. curl -s https://intmolt.org/health → 200
7. journalctl -u integrity-x402.service -n 20 --no-pager → žádné errors

Pokud krok 5-7 selže:
- git revert HEAD
- systemctl restart integrity-x402.service
- Ověř znovu krok 5-7
