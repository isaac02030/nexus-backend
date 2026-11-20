# Instruções para agentes

## Revisão obrigatória de PR

Antes de pedir o sim do Isaac, todo pull request passa por uma revisão só de leitura. Quem revisa é um agente diferente de quem escreveu o código. O revisor não edita nada: não muda arquivo, não faz commit e não abre correção. Só relata.

O relatório traz três coisas:

- o risco: baixo, médio ou alto
- os problemas, cada um com arquivo e linha
- a recomendação: mesclar, corrigir antes, ou precisa de decisão do dono

Nada é mesclado sem o sim do Isaac. A recomendação "mesclar" não autoriza o merge. Ela só diz que, na leitura do revisor, o pull request está pronto para o dono decidir.

### Checklist

O revisor confere cada item abaixo. Se um item não se aplica (por exemplo, o pull request não tem tela), o relatório diz isso em uma linha. Não pule o item em silêncio.

#### Autorização

- Toda rota nova ou alterada exige login.
- Confere se quem pede é o dono ou um participante. Participante vale para missão, par e comunidade.
- Quem não participa recebe 404 ou 403.
- Ex-participante não grava.
- Gravação exige recurso ativo.

#### Banco

- Migração é área sensível. Dá para voltar atrás? Apaga ou altera dados?
- As consultas são parametrizadas.

#### Dados pessoais e segredos

- Nenhuma chave, token, senha, nome real ou dado de saúde no código, nos testes ou na descrição do pull request.
- As respostas da API não expõem dados de outras pessoas.
- Textos sensíveis, como notas de crise, não são guardados onde não devem.

#### Testes

- Os testes passam.
- Existe teste do caso negado (quem não pode acessar ou gravar recebe a recusa esperada).

#### Telas (se houver)

- A tela trata erro, vazio e sem internet.
- Telas de crise são calmas: sem animação e sem cor de alarme.

#### Dependências

- Pacote, skill ou plugin novo de terceiros só entra depois de alguém ler o código dele e o Isaac dizer sim.
