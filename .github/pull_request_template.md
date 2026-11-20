## O que muda e por quê

<!--
Escreva em poucas linhas, em português simples.
Diga o que este pull request muda e por que a mudança é necessária.
Este repositório é público: não coloque chave, token, senha, nome real nem dado de saúde.
-->

## Área sensível

Crise, dados pessoais, senhas e banco pedem cuidado extra. Marque o que este pull request mexe. Se não mexe em nada disso, deixe as caixas vazias e escreva "não mexe" na linha de baixo.

- [ ] Crise (tela, texto ou fluxo de um momento difícil)
- [ ] Dados pessoais
- [ ] Senhas, chaves ou tokens
- [ ] Banco (migração, consulta ou dado já gravado)

Se marcou alguma caixa, diga o que muda e se dá para voltar atrás:

<!-- resposta -->

## Checklist

Marque cada item que você conferiu. Se o item não se aplica, marque e escreva "não se aplica" ao lado.

### Autorização

- [ ] Toda rota nova ou alterada exige login.
- [ ] Quem pede é o dono ou um participante (missão, par ou comunidade).
- [ ] Quem não participa recebe 404 ou 403.
- [ ] Ex-participante não grava.
- [ ] Gravação exige recurso ativo.

### Banco

- [ ] A migração foi tratada como área sensível: dá para voltar atrás? Apaga ou altera dados?
- [ ] As consultas são parametrizadas.

### Dados pessoais e segredos

- [ ] Não há chave, token, senha, nome real nem dado de saúde no código, nos testes ou nesta descrição.
- [ ] As respostas da API não expõem dados de outras pessoas.
- [ ] Textos sensíveis (notas de crise) não são guardados onde não devem.

### Testes

- [ ] Os testes passam.
- [ ] Existe teste do caso negado.

### Telas (se houver)

- [ ] A tela trata erro, vazio e sem internet.
- [ ] Telas de crise são calmas, sem animação e sem cor de alarme.

### Dependências

- [ ] Pacote, skill ou plugin novo de terceiros só entrou depois da leitura do código e do sim do Isaac.

## Revisado por (agente diferente de quem escreveu)

<!--
Nome do agente que fez a revisão só de leitura.
Não pode ser quem escreveu o código. O revisor não edita nada: só relata.
-->

- Risco: <!-- baixo, médio ou alto -->
- Problemas (arquivo e linha):
- Recomendação: <!-- mesclar / corrigir antes / precisa de decisão do dono -->

Nada é mesclado sem o sim do Isaac.
