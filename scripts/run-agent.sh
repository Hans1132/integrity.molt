#!/bin/bash
# run-agent.sh — Pomocník pro spouštění agentů
# Použití: bash scripts/run-agent.sh [conductor|backend|web|monitor|tester]

AGENT=${1:-conductor}
ROLE_FILE="agents/${AGENT}.md"

if [ ! -f "$ROLE_FILE" ]; then
  echo "❌ Agent '$AGENT' neexistuje. Dostupní: conductor, backend, web, monitor, tester"
  exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🤖 Spouštím agenta: $AGENT"
echo "📋 Role: $ROLE_FILE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Zobraz aktivní tasky pro tohoto agenta
ACTIVE_TASKS=$(find tasks/active/ -name "*${AGENT}*" -o -name "*$(echo $AGENT | cut -c1-4)*" 2>/dev/null)
if [ -n "$ACTIVE_TASKS" ]; then
  echo "📌 Aktivní tasky:"
  echo "$ACTIVE_TASKS"
else
  echo "📌 Žádné aktivní tasky pro $AGENT"
  echo "   Zkontroluj tasks/backlog/ nebo spusť conductor pro vytvoření tasků"
fi

echo ""
echo "💡 Vlož do Claude Code:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Jsi agent '${AGENT}'. Přečti svůj role file 'agents/${AGENT}.md' a CLAUDE.md."
if [ -n "$ACTIVE_TASKS" ]; then
  echo "Tvůj aktivní task je: $ACTIVE_TASKS"
  echo "Přečti ho a pracuj na něm."
else
  echo "Nemáš aktivní task. Řekni co mám dělat, nebo spusť conductor."
fi
echo "Po dokončení spusť: bash scripts/test-gate.sh"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━"
