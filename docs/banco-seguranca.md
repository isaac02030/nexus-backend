# Segurança do banco

Este guia explica como o servidor conversa com o Postgres e quem pode fazer o quê no banco. Nenhum valor real aparece aqui: senhas e segredos ficam só nas variáveis do provedor.

## 1. Uma conexão só (Pool único)

Todo o servidor usa um Pool só, em `lib/db.js`. Antes, cada rota abria o seu (eram 11, de até 10 conexões cada), e isso podia passar do limite de um plano pequeno.

- `DATABASE_POOL_MAX`: quantas conexões no máximo. Padrão 5, de 1 a 20.
- Ao desligar (o provedor manda SIGTERM ao reiniciar), o servidor para os lembretes, espera os pedidos em curso, fecha o Pool e sai. Se travar, sai depois de 10 segundos.

Teste feito: 60 pedidos ao mesmo tempo abriram 5 conexões no banco.

## 2. TLS obrigatório

A conexão com o banco é cifrada (TLS) por padrão. A variável `DATABASE_SSL` escolhe o modo:

| Modo | O que faz | Quando usar |
|---|---|---|
| `verify-full` (padrão) | cifra e confere o certificado e o nome do servidor | sempre que der |
| `verify-ca` | cifra e confere o certificado, sem o nome | provedor com certificado próprio, em `DATABASE_SSL_CA` |
| `require` | cifra, mas não confere o certificado | só se o provedor não der o certificado (o servidor avisa ao subir) |
| `disable` | sem TLS | só no seu computador, com o banco em `localhost` |

Regras:

- Com `NODE_ENV=production`, o servidor **não sobe** sem TLS (`disable`, `sslmode=disable` ou `ssl=false` na URL).
- `disable` fora de produção só vale com o banco nesta máquina (localhost, 127.0.0.1, ::1 ou socket). Para outro endereço, recusa.
- `sslmode=prefer` e `allow` são recusados: eles podem conectar sem TLS sem avisar.
- Se `DATABASE_SSL` e o `sslmode` da URL pedirem modos diferentes, o servidor recusa.
- `DATABASE_SSL_CA`: o certificado do provedor (texto PEM). Pode ir numa linha só, com `\n` no lugar das quebras.

A conferir no provedor escolhido: se a rede interna dele (servidor e banco no mesmo projeto) aceita TLS. Se não aceitar, o servidor não sobe em produção, e a saída é usar o endereço público com TLS. [DESCONHECIDO para o Railway.]

## 3. Segredos distintos

Em produção, o servidor não sobe se `JWT_SECRET` ou `VERTICE_SECRET`:

- faltarem;
- tiverem menos de 32 caracteres, ou repetirem poucos caracteres;
- forem o texto de exemplo do `env.example`;
- forem iguais entre si.

A mensagem diz qual variável corrigir, nunca o valor. Para gerar cada um:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

O `POST /api/vertice/notify-all` usa só o `VERTICE_SECRET`. Se ele faltar ou for igual ao `JWT_SECRET`, a rota fica desligada (503). O `JWT_SECRET` não abre mais essa porta.

## 4. Usuário do app sem poder de dono

O banco tem dois usuários (papéis):

| Usuário | Para quê | Pode |
|---|---|---|
| das migrações (dono) | rodar `migrations/*.sql` | tudo: criar, mudar e apagar tabelas |
| `nexus_app` | o servidor no ar (`DATABASE_URL`) | só ler e gravar linhas: SELECT, INSERT, UPDATE, DELETE |

Assim, se alguém achar uma falha no servidor, não consegue apagar tabelas nem mudar a estrutura do banco.

O usuário das migrações precisa poder criar papéis (CREATEROLE). O usuário que o provedor entrega costuma ter. [A conferir no provedor escolhido.]

### Passo a passo (banco novo)

1. Com o endereço do usuário das migrações, rode as migrações em ordem (`001` a `006`).
2. Rode o script do papel do app:

   ```bash
   psql "<endereço do usuário das migrações>" -v ON_ERROR_STOP=1 -f scripts/sql/papel-do-app.sql
   ```

3. No mesmo psql, ponha a senha (o psql pergunta, nada fica escrito):

   ```
   \password nexus_app
   ```

4. No provedor, a `DATABASE_URL` do servidor passa a usar `nexus_app` e essa senha. O endereço do usuário das migrações não fica no servidor.

O script pode rodar de novo sem problema. Rode de novo **depois de cada migração nova** e **depois de cada restauração de backup**. Ele também confere se o `nexus_app` não ganhou poder a mais (e para se tiver).

### O que o servidor deixou de fazer

As rotas criavam colunas e tabelas sozinhas ao rodar (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`). Com o `nexus_app`, isso dá erro ("must be owner"), mesmo quando a coluna já existe. Tudo isso já está nas migrações `001` e `002`, então saiu das rotas. A estrutura do banco agora vem só das migrações.

### Teste feito (Postgres descartável, dados falsos)

Com o `nexus_app`: ler, gravar, mudar e apagar linhas funcionou; o servidor em modo produção fez cadastro, login, missão e check-in. Foram recusados: `CREATE TABLE`, tabela temporária, `DROP TABLE`, `TRUNCATE`, `ALTER TABLE`, gravar em `schema_migrations` e criar papel.
