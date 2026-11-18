# Backup do banco

O Nexus guarda os dados no Postgres. Estes comandos fazem uma cópia desse banco no seu computador e conseguem colocar essa cópia de volta.

Não há senha nenhuma no código. A conexão vem da variável `DATABASE_URL` (do terminal, ou do arquivo `.env` se ele existir). O `.env` fica de fora do GitHub.

## O que você precisa

- O Postgres ligado.
- Os programas `pg_dump` e `pg_restore` instalados. Eles vêm com o PostgreSQL.
- As dependências do projeto instaladas, uma vez: `npm install`.
- `DATABASE_URL` apontando para o banco. O caminho simples é copiar `env.example` para `.env` e preencher essa linha.

Se `DATABASE_URL` já estiver definida no terminal, essa vale. O `.env` só é usado quando a variável ainda não existe.

## Fazer backup

Na pasta do backend:

```bash
npm run db:backup
```

Isso cria um arquivo em `backups/`, com a data e a hora no nome. Exemplo: `backups/nexus-2026-11-18T19-30-00-000Z.dump`.

A pasta `backups/` está no `.gitignore`. Não envie esses arquivos para o GitHub: eles podem ter dados de pessoas.

## Restaurar

O comando não cria o banco. Ele preenche um banco que já existe. Se você apagou o banco, crie outro vazio com o mesmo nome que está em `DATABASE_URL` e só depois restaure.

```bash
npm run db:restore -- backups/nexus-2026-11-18T19-30-00-000Z.dump
```

Troque o nome pelo arquivo que você quer recuperar. A restauração substitui as tabelas desse banco pelo conteúdo do backup. Antes, faça um backup novo se ainda precisar do que está lá agora.

## Produção

Estes comandos são manuais, para o seu computador. Em produção o backup precisa ser automático (por exemplo todo dia, guardado em outro lugar, fora do servidor). Isso ainda não está feito. Não basta este comando manual quando o app estiver no ar.
