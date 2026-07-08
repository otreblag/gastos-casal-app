# Finannza — versão local (sem API)

Controle financeiro do casal com classificação automática por palavras-chave.
100% offline, sem internet, sem API externa.

## Como rodar

```bash
npm install
npm start          # testar
npm run build:win  # gerar .exe
```

## Categorias
- Gerencie categorias e palavras-chave direto na aba "Categorias"
- Adicione novas categorias com ícone e cor personalizada
- Adicione ou remova palavras de qualquer categoria
- As alterações são salvas automaticamente

## Bot do Telegram (opcional)
- @BotFather → /newbot → copie o Token
- Adicione o bot a um grupo + @userinfobot para obter o ID
- Configure na aba "Bot Telegram" e clique em Iniciar
- Mande mensagens como "Mercado 87,50" ou "Uber 23" no grupo

## Como funciona a classificação
O sistema compara as palavras da mensagem com um dicionário de +600 palavras
organizadas em categorias. Quanto mais palavras específicas encontrar, maior
a confiança. O valor é extraído por expressões regulares.

## Atualização automática (electron-updater + GitHub Releases)

O app verifica atualizações automaticamente ao abrir (`autoUpdater.checkForUpdatesAndNotify()`
em `main.js`, só roda quando empacotado — `npm start` em modo dev não verifica). Também dá para
checar manualmente pelo menu **Arquivo → Verificar atualizações**. Quando uma atualização é
baixada, aparece um diálogo perguntando se quer reiniciar agora ou depois.

As atualizações são publicadas como *GitHub Releases* no repositório
[`otreblag/gastos-casal-app`](https://github.com/otreblag/gastos-casal-app).

### Publicando uma nova versão

1. Incrementar `"version"` em `package.json` (ex: `1.0.0` → `1.1.0`)
2. Definir a variável de ambiente `GH_TOKEN` com um [Personal Access Token](https://github.com/settings/tokens)
   do GitHub com permissão `repo` (necessário para o electron-builder publicar o release):
   ```powershell
   $env:GH_TOKEN = "seu_token_aqui"
   ```
3. Rodar:
   ```bash
   npm run release
   ```
   Isso gera o instalador (`electron-builder --win --x64`) **e** publica automaticamente
   como GitHub Release no repositório configurado em `package.json` → `build.publish`.
4. Aguardar o upload terminar — o instalador (`.exe`) fica disponível na aba
   [Releases](https://github.com/otreblag/gastos-casal-app/releases) do repositório.
5. Qualquer instalação existente do app detecta a nova versão e baixa sozinha na
   próxima vez que for aberta.

> **Nota:** `npm run build:win` continua gerando o instalador localmente em `/dist`
> **sem publicar** — use `npm run release` só quando quiser efetivamente lançar a versão.
