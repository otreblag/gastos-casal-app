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

## Versão mobile (somente leitura) — consulta pelo celular

Uma página web **somente leitura** (`mobile/`) permite consultar os gastos pelo
navegador do celular, **mesmo com o PC desligado**. Ela não edita nada — só exibe.

**Como funciona:** o app do PC publica um resumo consolidado (gastos do ano,
totais por mês/categoria/pessoa e o saldo da divisão) na sua planilha do Google,
via o mesmo Apps Script do bot. A página mobile lê esse resumo. Nenhum token ou
segredo entra no resumo publicado.

### 1. Atualizar o Apps Script (uma vez)
O `apps-script.gs` ganhou duas ações novas (`publicar_snapshot` no `doPost` e
`ler_snapshot`/`listar` num `doGet` consolidado). Cole o conteúdo atualizado de
[`apps-script.gs`](https://github.com/otreblag/gastos-bot) no editor (planilha →
Extensões → Apps Script) e **edite a implantação existente** (Nova versão) — não
crie uma implantação nova (geraria uma URL diferente). Se houver um `doGet` antigo
em outro arquivo do projeto, remova-o (o novo `doGet` consolida `listar` + `ler_snapshot`).

### 2. Publicar o resumo pelo app do PC
Na aba **Config → 📱 Versão mobile**, clique em **"📱 Atualizar versão mobile"**.
Também publica sozinho ao salvar dados (no máximo 1×/5min), desde que a URL e o
token do Apps Script estejam configurados (card "☁️ Sincronizar com Google Sheets").

### 3. Acessar no celular
A página é servida via **GitHub Pages**:

> **https://otreblag.github.io/gastos-casal-app/mobile/**

Na primeira visita, informe a **URL do Apps Script** (a mesma do app, terminada em
`/exec`) e o **token secreto** (`SECRET_TOKEN`). Ficam salvos só naquele aparelho
(localStorage do navegador). Dica: adicione a página à tela inicial do celular
("Adicionar à tela de início") para abrir como um app. Sem o token correto, nada é
exibido. Depois do primeiro carregamento, funciona **offline** (mostra o último
resumo salvo, com a data no topo).

**Publicando a página mobile (GitHub Pages):** em *Settings → Pages* do repositório
`otreblag/gastos-casal-app`, defina **Source: Deploy from a branch**, branch `main`,
pasta `/ (root)`. A pasta `mobile/` fica acessível na URL acima. O `.nojekyll` na
raiz garante que os arquivos sejam servidos sem processamento do Jekyll.

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
