import assert from 'assert';
import {
  extrairInformacoes,
  validarRelato,
  aplicarMotor,
  processarTurno,
  ESTADO_INICIAL,
} from '../../ia';
import { mensagemPorId, sanitizarResposta } from '../../ia/mensagens';
import cenarios from './cenarios_simulados.json';
import esperados from './resultados_esperados.json';

async function main() {
  // 1. Extração para terceiros
  const extraido = extrairInformacoes(
    'Minha mãe caiu, bateu a cabeça e agora está meio confusa.',
  );
  assert.strictEqual(extraido.relato_sobre_terceiro, true);
  assert.strictEqual(extraido.pessoa, 'mãe');
  assert.ok(extraido.trauma === true);
  assert.ok(extraido.confusao === true);
  assert.ok(!extraido.sintomas.some((s) => /infarto|avc/i.test(s)));

  // 2. Validação de entrada inválida
  const validacao = validarRelato({ sintomas: 'febre', gestante: 'talvez' });
  assert.strictEqual(validacao.ok, false);
  assert.strictEqual(validacao.relato.gestante, 'nao_informado');
  assert.ok(Array.isArray(validacao.relato.sintomas));

  // 3. Cenários simulados
  for (const cenario of cenarios) {
    const relato = extrairInformacoes(cenario.entrada);
    const decisao = aplicarMotor(relato);
    const esperado = esperados[cenario.id as keyof typeof esperados];
    assert.strictEqual(decisao.resposta_id, esperado.resposta_id, cenario.id);
    assert.strictEqual(decisao.destino, esperado.destino, cenario.id);
    assert.strictEqual(decisao.categoria_interna, cenario.categoria, cenario.id);
    assert.ok(decisao.regra_acionada !== undefined);
    assert.strictEqual(decisao.versao_regras, '1.0.0');
  }

  // 4. Sanitização de diagnóstico bloqueado
  const diagnostico = sanitizarResposta('Isso é um infarto. Tome AAS.');
  assert.strictEqual(diagnostico, mensagemPorId('fallback_001').texto);

  // 5. Fluxo: mensagem vaga → perguntas
  const vago = await processarTurno('oi', ESTADO_INICIAL);
  assert.strictEqual(vago.resultado.tipo, 'perguntas');

  // 6. Emergência direta
  const emergencia = await processarTurno(
    'Estou com dor no peito, falta de ar e suor frio.',
    ESTADO_INICIAL,
  );
  assert.strictEqual(emergencia.resultado.tipo, 'orientacao');
  if (emergencia.resultado.tipo === 'orientacao') {
    assert.strictEqual(emergencia.resultado.decisao.resposta_id, 'emergencia_001');
  }

  // 7. Após pergunta, resposta com orientação
  const aposPergunta = await processarTurno('só uma coriza', vago.estado);
  assert.strictEqual(aposPergunta.resultado.tipo, 'orientacao');

  console.log('🎉 testes da IA: ok');
}

main().catch((erro) => {
  console.error('❌ Erro nos testes:', erro);
  throw erro;
});