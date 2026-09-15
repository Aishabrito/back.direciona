"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const ia_1 = require("../../ia");
const mensagens_1 = require("../../ia/mensagens");
const cenarios_simulados_json_1 = __importDefault(require("./cenarios_simulados.json"));
const resultados_esperados_json_1 = __importDefault(require("./resultados_esperados.json"));
async function main() {
    // 1. Extração para terceiros
    const extraido = (0, ia_1.extrairInformacoes)('Minha mãe caiu, bateu a cabeça e agora está meio confusa.');
    assert_1.default.strictEqual(extraido.relato_sobre_terceiro, true);
    assert_1.default.strictEqual(extraido.pessoa, 'mãe');
    assert_1.default.ok(extraido.trauma === true);
    assert_1.default.ok(extraido.confusao === true);
    assert_1.default.ok(!extraido.sintomas.some((s) => /infarto|avc/i.test(s)));
    // 2. Validação de entrada inválida
    const validacao = (0, ia_1.validarRelato)({ sintomas: 'febre', gestante: 'talvez' });
    assert_1.default.strictEqual(validacao.ok, false);
    assert_1.default.strictEqual(validacao.relato.gestante, 'nao_informado');
    assert_1.default.ok(Array.isArray(validacao.relato.sintomas));
    // 3. Cenários simulados
    for (const cenario of cenarios_simulados_json_1.default) {
        const relato = (0, ia_1.extrairInformacoes)(cenario.entrada);
        const decisao = (0, ia_1.aplicarMotor)(relato);
        const esperado = resultados_esperados_json_1.default[cenario.id];
        assert_1.default.strictEqual(decisao.resposta_id, esperado.resposta_id, cenario.id);
        assert_1.default.strictEqual(decisao.destino, esperado.destino, cenario.id);
        assert_1.default.strictEqual(decisao.categoria_interna, cenario.categoria, cenario.id);
        assert_1.default.ok(decisao.regra_acionada !== undefined);
        assert_1.default.strictEqual(decisao.versao_regras, '1.0.0');
    }
    // 4. Sanitização de diagnóstico bloqueado
    const diagnostico = (0, mensagens_1.sanitizarResposta)('Isso é um infarto. Tome AAS.');
    assert_1.default.strictEqual(diagnostico, (0, mensagens_1.mensagemPorId)('fallback_001').texto);
    // 5. Fluxo: mensagem vaga → perguntas
    const vago = await (0, ia_1.processarTurno)('oi', ia_1.ESTADO_INICIAL);
    assert_1.default.strictEqual(vago.resultado.tipo, 'perguntas');
    // 6. Emergência direta
    const emergencia = await (0, ia_1.processarTurno)('Estou com dor no peito, falta de ar e suor frio.', ia_1.ESTADO_INICIAL);
    assert_1.default.strictEqual(emergencia.resultado.tipo, 'orientacao');
    if (emergencia.resultado.tipo === 'orientacao') {
        assert_1.default.strictEqual(emergencia.resultado.decisao.resposta_id, 'emergencia_001');
    }
    // 7. Após pergunta, resposta com orientação
    const aposPergunta = await (0, ia_1.processarTurno)('só uma coriza', vago.estado);
    assert_1.default.strictEqual(aposPergunta.resultado.tipo, 'orientacao');
    console.log('🎉 testes da IA: ok');
}
main().catch((erro) => {
    console.error('❌ Erro nos testes:', erro);
    throw erro;
});
