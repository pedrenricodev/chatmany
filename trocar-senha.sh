#!/bin/bash
# Troca a senha do painel (secret OWNER_TOKEN) sem ela aparecer na tela,
# no histórico do shell, nem em nenhum log. Atualiza o SEGREDOS.txt junto.
#
#   ./trocar-senha.sh         painel do @pedroenrico.ia
#   ./trocar-senha.sh iafin   painel do @ianasfinancas
#
set -euo pipefail
cd "$(dirname "$0")"

MIN=14
if [ "${1:-}" = "iafin" ]; then
  CFG=(-c wrangler.iafin.toml); ARQ="SEGREDOS-iafin.txt"; URL="https://chatmany-iafin.pedro-9e8.workers.dev"
else
  CFG=(); ARQ="SEGREDOS.txt"; URL="https://chatmany.pedro-9e8.workers.dev"
fi

echo "Nova senha do painel."
echo "Mínimo $MIN caracteres. Use uma FRASE, não uma palavra: o painel"
echo "está numa URL pública e não trava tentativas de chute."
echo

read -rs -p "Nova senha: " S1; echo
read -rs -p "Repete:     " S2; echo
echo

if [ "$S1" != "$S2" ]; then
  echo "As duas não bateram. Nada foi alterado."; exit 1
fi
if [ "${#S1}" -lt "$MIN" ]; then
  echo "Tem ${#S1} caracteres, o mínimo é $MIN. Nada foi alterado."; exit 1
fi

echo "Gravando no Cloudflare..."
printf '%s' "$S1" | npx wrangler secret put OWNER_TOKEN "${CFG[@]+"${CFG[@]}"}" >/dev/null 2>&1

# Confere de verdade contra a API antes de dizer que deu certo.
echo "Esperando propagar..."
sleep 6
CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $S1" \
  "$URL/api/status")

if [ "$CODE" != "200" ]; then
  echo
  echo "FALHOU: a API respondeu $CODE em vez de 200."
  echo "A senha antiga pode ainda estar valendo. Roda de novo."
  unset S1 S2; exit 1
fi

# Atualiza o arquivo local pra ele não mentir.
python3 - "$ARQ" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
linhas = p.read_text().splitlines()
for i, l in enumerate(linhas):
    if l.startswith("Senha do painel"):
        linhas[i] = "Senha do painel (OWNER_TOKEN):"
        linhas[i+1] = "  <senha escolhida pelo Pedro em " + __import__("time").strftime("%d/%m/%Y") + ", não guardada aqui>"
        break
p.write_text("\n".join(linhas) + "\n")
PY

unset S1 S2
echo
echo "Pronto. Senha trocada e testada contra a API: HTTP 200."
echo "O token antigo de 64 caracteres não vale mais."
echo "Painel: $URL"
