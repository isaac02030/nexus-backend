# Relatório do Codex

## Feito
- Criados `docs/conselho/decisoes.md` e `docs/conselho/agentes.md` com as instruções fornecidas para o conselho do Nexus.
- O emparelhamento automático no backend agora exige `MATCHING_ENABLED=true`; sem essa configuração, permanece desligado.
- O frontend só consulta pares quando o backend informa que o interruptor está ligado e informa quando a procura está desligada.
- Commit `8b0cc18` enviado ao branch `codex/nexus-council-and-matching-switch`.

## Pendente
- Abrir pull requests para revisão; nada foi mesclado em `main`.
- Aplicar a migração ao banco somente quando houver um ambiente de banco autorizado.

## Dúvidas
- Nenhuma nesta etapa.

## Feito em 18/11/2026 — backup do banco

- Não existe `AGENTS.md` neste repositório. A tarefa seguiu `docs/conselho/decisoes.md`.
- `.gitignore` para Node: dependências, `.env` e variantes, logs, dumps de backup e arquivos de sistema. `env.example` continua versionado.
- O `JWT_SECRET` de exemplo deixou de ser um texto aproveitável e passou a ser o placeholder `troque-por-um-segredo-longo-e-aleatorio`.
- Scripts `npm run db:backup` e `npm run db:restore`, com `pg_dump` / `pg_restore` e `DATABASE_URL` vinda do ambiente. Os dumps ficam em `backups/`, pasta ignorada pelo Git.
- Guia em português: `docs/backup.md`. Backup automático de produção ficou só documentado, sem implementação.
- Prova local, num Postgres descartável que depois foi apagado: migração `database.sql`, uma linha fictícia, backup, banco apagado, banco vazio recriado, restauração, e a linha voltou. Uma segunda restauração desfez uma alteração feita depois do backup. O mesmo teste também passou com `DATABASE_URL` no formato `postgresql://usuario:senha@127.0.0.1:5432/banco`. A senha não apareceu na saída. Nada disso foi commitado (nem o dump, nem senha, nem a linha de teste).

## Pendente nesta etapa
- Backup automático em produção.
- Nada foi mesclado em `main`. Railway não foi alterado.

## Feito em 18/11/2026 — horário do lembrete

- Migration `migrations/002_user_reminder.sql`: colunas `reminder_time` e `timezone` em `users`, as duas podem ficar vazias. Rodar de novo não apaga dado.
- Rotas `GET` e `PUT /api/users/me/reminder`, com login. Horário inválido ou fuso inválido responde 400 em português.
- Quem escolhe um horário recebe esse lembrete todo dia, se a missão estiver ativa. Os outros dois avisos (4 horas e 8 horas em relação a esse horário) só saem se o check-in de hoje, no fuso da pessoa, ainda não foi feito. Quem não escolheu horário continua no comportamento antigo.
- Esses avisos são só push. Não entram no chat e não contam no limite de conversas com a IA.
- Em desenvolvimento, o CORS aceita `http://localhost:8080`. Com `NODE_ENV=production`, esse endereço não entra.
- Prova local num Postgres descartável: a migration rodou duas vezes, o PUT/GET funcionou com login e recusou horário e fuso ruins, e `npm test` passou (11 testes). O padrão dos dois horários extras está no pull request para o dono confirmar.
- Nada foi mesclado em `main`. Railway não foi alterado.
