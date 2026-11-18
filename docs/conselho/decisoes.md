# Instruções para o Codex — Conselho do Nexus

## Como trabalhamos

- As decisões do projeto vêm de um conselho de agentes de IA, coordenado pelo Maestro. A decisão final é sempre do Isaac (dono do projeto).
- A comunicação entre o Codex e o conselho é feita por arquivos neste repositório, não por e-mail:
  - Leia `docs/conselho/decisoes.md` antes de cada tarefa.
  - Ao terminar, escreva o que fez, o que ficou pendente e suas dúvidas em `docs/conselho/relatorio-codex.md`.
- Este repositório é PÚBLICO. Nunca coloque aqui chaves, senhas, tokens, dados de usuários, nomes de testers ou qualquer informação pessoal.
- Ao citar um conselheiro, use o nome junto com a responsabilidade dele (ex.: "Vitrúvio, o Arquiteto").

## Conselho

- Maestro: coordenador, rege o conselho e fala com o Isaac.
- Vitrúvio: Arquiteto de Software (parte técnica e código).
- Clara: Designer de UX (experiência de uso, visual e o que o usuário sente).
- Tomé: Analista de Negócios (mercado, custos, dados antes de gastar).
- Norte: Estrategista de Produto (o que entra agora e o que fica pra depois).
- Zé: Leigo (olhar de quem usa o app).
- Pirro: Advogado do Diabo (questiona e aponta riscos).
- Eventuais: filósofo (convidado na reunião sobre a IA), revisão de segurança (pontual, antes dos testers), marketing (só no lançamento).
- O Isaac participa das reuniões por áudio ou com 3 a 5 linhas, depois que os conselheiros opinam.

## Novidades desde a última atualização

1. A OpenAI desliga o gpt-4o-mini (e também gpt-4o, gpt-4.1 e gpt-4.1-mini) em 14/01/2027. Fonte: https://platform.openai.com/docs/deprecations. A IA do app será refeita do zero, então não faça a troca agora. Só não dependa desses modelos em código novo.
2. Contratações: nenhum membro fixo novo. A segurança será uma revisão pontual antes dos testers, usando a revisão de segurança do próprio Codex (`@codex security review`) e a lista OWASP Top 10.
3. Direção do beta (reunião 3):
   - Todos começam em modo Solo. O Duo é só por convite a alguém que a pessoa já conhece. O emparelhamento automático com desconhecidos fica desligado no beta e volta quando houver mais usuários.
   - Primeiro teste só pelo app web instalável (PWA), sem a Play Store.
   - Check-in com uma pergunta curta baseada no contrato da pessoa, no lugar do botão vazio.
   - Dias difíceis: 4 por missão de 30 dias, e em cada um a pessoa faz o mínimo do contrato. Quando acabam, o dia conta como falta normal e entra a recuperação.
   - A IA ("Grande Irmão") entra por último, atrás de um interruptor, e não pode atrasar o teste.

## Meta "pronto para testers" (ordem sugerida, um item por vez)

1. Banco novo, criado do zero, com migrações e backup.
2. Modo Solo para todos e Duo por convite.
3. Do cadastro ao primeiro check-in em menos de 3 minutos, no Android e no iPhone. Lembrete diário funcionando (no iPhone o push só funciona com o app adicionado à Tela de Início).
4. Check-in com pergunta, dias difíceis limitados, recuperação.
5. Segurança básica: limite de tentativas no login, segredo do JWT forte, excluir conta, aviso de privacidade.
6. Registro de erros e métricas simples.

Critério de pronto: o Isaac e mais uma pessoa usam o app 7 dias seguidos sem nenhum erro que trave.

## Atualização 18/11/2026 — mudança no desenvolvimento (decisão do Isaac)

1. Prioridade: o código vem primeiro. O conselho espera a renovação do limite semanal de uso.
2. O Codex envia todo o trabalho local para o GitHub (commit + push) antes de qualquer outra coisa, sem segredos.
3. O desenvolvimento passa para um agente novo do conselho, o Dédalo (o Desenvolvedor), que escolheu esse nome. O Codex fica só de reserva.  
   Regras do Dédalo: uma tarefa pequena por vez, com critério de pronto; tudo por pull request com explicação simples; nada entra no main nem vai ao ar sem o sim do Isaac; áreas sensíveis sempre sinalizadas; nada de segredos, nomes de testers ou dados de saúde no repositório público; economizar o limite de uso.
4. O emparelhamento automático fica no código, mas desligado por um interruptor (ex.: `MATCHING_ENABLED=false`). Não apague esse código.
5. IA (decisão de 18/11): provedor Groq, modelo GPT-OSS 20B. No app, de 1 a 4 trocas por dia (a IA pergunta, a pessoa responde e pode continuar). As 3 notificações por dia (manhã, tarde e perto da noite) são à parte e não contam nesse limite. A IA continua entrando por último, atrás de um interruptor.
6. Railway: o teste acabou e os serviços estão fora do ar. O banco atual era só de teste e pode ser descartado. Não faça nada no Railway sem o sim do Isaac.

