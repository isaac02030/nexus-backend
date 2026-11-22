# Backup do banco

O Nexus guarda os dados no Postgres. Estes comandos fazem uma cópia do banco e conseguem colocar essa cópia de volta. A cópia pode sair cifrada.

Não há senha nenhuma no código. A conexão vem da variável `DATABASE_URL` (do terminal, ou do arquivo `.env` se ele existir). O `.env` fica de fora do GitHub.

## O que você precisa

- O Postgres ligado.
- Os programas `pg_dump` e `pg_restore`. Eles vêm com o PostgreSQL. A versão deles precisa ser igual ou mais nova que a do banco.
- As dependências do projeto instaladas, uma vez: `npm install`.
- `DATABASE_URL` apontando para o banco.

Se `DATABASE_URL` já estiver definida no terminal, essa vale. O `.env` só é usado quando a variável ainda não existe.

Os scripts seguem as mesmas regras de TLS do servidor (ver `docs/banco-seguranca.md`): banco fora desta máquina só com TLS. A senha sai do endereço e vai para o `pg_dump` por variável, para não aparecer na lista de processos.

## Fazer backup

```bash
BACKUP_PASSPHRASE='uma frase longa só sua' npm run db:backup
```

- Com `BACKUP_PASSPHRASE` (16 caracteres ou mais), sai `backups/nexus-<data>.dump.enc`, cifrado. O arquivo aberto é apagado na hora.
- Banco fora desta máquina (provedor, produção): a frase é obrigatória. Sem ela, o backup recusa e não copia nada.
- Banco local sem a frase: sai `backups/nexus-<data>.dump`, **aberto**, e o script avisa. Esse não sai deste computador.

A cifra usa só o `crypto` do Node (scrypt + AES-256-GCM), sem programa novo. Arquivo trocado ou frase errada são recusados.

**Guarde a frase fora do computador** (num gerenciador de senhas). Sem ela, o backup cifrado não abre. Não há como recuperar.

A pasta `backups/` e os arquivos `*.dump` e `*.enc` estão no `.gitignore`. Mesmo cifrados, não vão para o GitHub público.

## Restaurar

O comando não cria o banco. Ele preenche um banco que já existe (pode estar vazio). A restauração substitui as tabelas desse banco pelas do backup. Antes, faça um backup novo se ainda precisar do que está lá.

```bash
BACKUP_PASSPHRASE='a mesma frase' npm run db:restore -- backups/nexus-2026-11-21T23-47-28-351Z.dump.enc
```

1. Use o endereço do **usuário das migrações** (o dono), não o do app.
2. O backup cifrado é aberto inteiro numa pasta temporária, conferido, e só então vai para o banco. Depois a pasta é apagada.
3. Depois de restaurar, rode de novo `scripts/sql/papel-do-app.sql` (e o `papel-do-backup.sql`, se usar). O backup não leva as permissões, e sem isso o app recebe "permission denied".

## Plano para produção (a decidir pelo dono do projeto)

O backup que mora junto do banco não basta: se o projeto no provedor for apagado, ele vai junto. O plano tem três camadas, sem serviço pago novo:

1. **Backup do provedor**, se o plano tiver (no Railway Hobby: [DESCONHECIDO], conferir por escrito). Serve para erro rápido.
2. **Backup externo diário e cifrado**, feito por uma tarefa agendada fora do provedor. Sugestão: GitHub Actions num repositório **privado e separado** só para isso (não nos repositórios públicos do app, nem no do conselho). A tarefa roda `npm run db:backup` com o usuário só de leitura e guarda o `.dump.enc` como artefato.
   - Limites grátis do GitHub Actions em repositório privado (minutos por mês, espaço de artefatos, dias de guarda): [A CONFERIR na página oficial; docs.github.com estava bloqueado nesta sessão].
   - Segredos dessa tarefa, só nas configurações do repositório privado: endereço do `nexus_backup`, `DATABASE_SSL_CA` (se precisar) e `BACKUP_PASSPHRASE`.
   - Limite honesto: quem entrar nessa conta do GitHub tem a frase e os arquivos. A cifra protege o arquivo se ele vazar sozinho, não a conta. Por isso: 2FA na conta, e o usuário do backup só lê. Melhoria possível depois: cifra com chave pública (a tarefa só cifra; só o dono do projeto decifra).
3. **Cópia semanal no computador do dono do projeto**, cifrada, num disco também cifrado (BitLocker/FileVault). Guardar só as últimas 4 e apagar as velhas.

Ainda não existe nada agendado. Criar o repositório privado, a tarefa e os segredos é um passo separado, com o sim do dono do projeto.

### Usuário só de leitura para o backup

```bash
psql "<endereço do usuário das migrações>" -v ON_ERROR_STOP=1 -f scripts/sql/papel-do-backup.sql
```

Depois, no mesmo psql: `\password nexus_backup`. Ele só lê: não grava, não apaga, não cria. Se o endereço dele vazar, ninguém muda o banco com ele, mas lê tudo. Guarde como segredo.

### Exemplo da tarefa agendada (não está ativa)

Só um modelo para o repositório privado de backup. Revisar antes de usar.

```yaml
name: backup-diario
on:
  schedule:
    - cron: '30 3 * * *'   # 03:30 UTC
  workflow_dispatch:
jobs:
  backup:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with:
          repository: <dono>/nexus-backend
          ref: codex/nexus-council-and-matching-switch
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci --omit=dev
      - run: sudo apt-get update && sudo apt-get install -y postgresql-client
      - run: npm run db:backup
        env:
          DATABASE_URL: ${{ secrets.BACKUP_DATABASE_URL }}
          DATABASE_SSL_CA: ${{ secrets.DATABASE_SSL_CA }}
          BACKUP_PASSPHRASE: ${{ secrets.BACKUP_PASSPHRASE }}
      - uses: actions/upload-artifact@v4
        with:
          name: backup-${{ github.run_id }}
          path: backups/*.dump.enc
          retention-days: 30
```

## Teste de restauração (antes do primeiro tester, e depois 1 vez por mês)

Backup que nunca foi restaurado não é backup. O teste:

1. Num banco de ensaio (dados falsos), anote quantas linhas tem `users`, `missions` e `checkins`.
2. `npm run db:backup` com `BACKUP_PASSPHRASE`.
3. Tente restaurar com uma frase errada: tem de recusar e o banco não muda.
4. Apague o banco e crie um vazio com o mesmo nome.
5. `npm run db:restore -- backups/<arquivo>.dump.enc` com a frase certa.
6. Confira as contagens: têm de ser iguais às do passo 1.
7. Rode `scripts/sql/papel-do-app.sql` e confira que o app volta a ler.
8. Anote a data e o resultado (sem dados de pessoas).

### Resultado do teste feito em 21/11/2026 (Postgres 16 descartável, com TLS, dados falsos)

- 20 usuários, 1 missão e 1 check-in falsos, gravados pelo `nexus_app`.
- Backup cifrado: nenhum texto aberto dentro do arquivo.
- Frase errada: recusada, banco igual.
- Banco apagado, criado vazio, restaurado: contagens e resumo (md5) das linhas **iguais** aos de antes.
- Antes de reaplicar o papel, o app recebeu "permission denied"; depois, voltou a ler.
- Backup feito com o `nexus_backup` (só leitura) e restaurado num segundo banco vazio: igual.

Falta repetir no provedor escolhido, com o banco de ensaio dele.
