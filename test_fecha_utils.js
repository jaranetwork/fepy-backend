/**
 * Script de prueba para verificar normalización de fechas de ERPNext
 * 
 * Uso: node test_fecha_utils.js
 */

const { normalizarDatetime, normalizarFechasEnObjeto, esFechaValida, formatoFechaSIFEN } = require('./utils/fechaUtils');

console.log('===========================================');
console.log('🧪 TEST: Normalización de Fechas ERPNext');
console.log('===========================================\n');

// Casos de prueba
const casosPrueba = [
  {
    descripcion: 'Fecha ERPNext con microsegundos',
    entrada: '2026-02-24T15:12:58.715809',
    esperado: '2026-02-24T15:12:58.715Z'
  },
  {
    descripcion: 'Fecha ISO estándar',
    entrada: '2026-02-24T15:12:58.715Z',
    esperado: '2026-02-24T15:12:58.715Z'
  },
  {
    descripcion: 'Fecha sin zona horaria',
    entrada: '2026-02-24T15:12:58',
    esperado: '2026-02-24T15:12:58.000Z'
  },
  {
    descripcion: 'Fecha con offset',
    entrada: '2026-02-24T15:12:58.715809-03:00',
    esperado: 'Debe normalizar correctamente'
  },
  {
    descripcion: 'Objeto Date',
    entrada: new Date('2026-02-24T15:12:58.715Z'),
    esperado: '2026-02-24T15:12:58.715Z'
  },
  {
    descripcion: 'Timestamp (número)',
    entrada: new Date('2026-02-24T15:12:58.715Z').getTime(),
    esperado: '2026-02-24T15:12:58.715Z'
  },
  {
    descripcion: 'Fecha inválida',
    entrada: 'fecha-invalida',
    esperado: 'Debe retornar fecha actual'
  },
  {
    descripcion: 'Null',
    entrada: null,
    esperado: 'Debe retornar fecha actual'
  },
  {
    descripcion: 'Undefined',
    entrada: undefined,
    esperado: 'Debe retornar fecha actual'
  }
];

let pasados = 0;
let fallidos = 0;

casosPrueba.forEach((caso, index) => {
  console.log(`\n📋 Prueba ${index + 1}: ${caso.descripcion}`);
  console.log(`   Entrada: ${caso.entrada}`);
  
  try {
    const resultado = normalizarDatetime(caso.entrada);
    console.log(`   Resultado: ${resultado}`);
    
    // Validar si el resultado es razonable
    const esValido = esFechaValida(resultado);
    
    if (esValido) {
      console.log('   ✅ PASADO - Fecha válida');
      pasados++;
    } else {
      console.log('   ❌ FALLIDO - Fecha inválida');
      fallidos++;
    }
  } catch (error) {
    console.log(`   ❌ FALLIDO - Error: ${error.message}`);
    fallidos++;
  }
});

// Prueba de normalización de objeto completo
console.log('\n\n===========================================');
console.log('🧪 TEST: Normalización de Objeto ERPNext');
console.log('===========================================\n');

const objetoERPNext = {
  ruc: '80012345-1',
  numero: '0000060',
  fecha: '2026-02-24T15:12:58.715809',
  cliente: {
    nombre: 'Test S.A.',
    ruc: '80098765-2',
    fecha_nacimiento: '1990-05-15T00:00:00.000000'
  },
  items: [
    {
      descripcion: 'Producto 1',
      cantidad: 1,
      precio: 100
    }
  ],
  created: '2026-02-24T15:12:58.715809',
  modified: '2026-02-24T16:30:45.123456'
};

console.log('Objeto original:');
console.log(JSON.stringify(objetoERPNext, null, 2));

console.log('\n📅 Normalizando fechas...');
const objetoNormalizado = normalizarFechasEnObjeto({ ...objetoERPNext, cliente: { ...objetoERPNext.cliente } });

console.log('\nObjeto normalizado:');
console.log(JSON.stringify(objetoNormalizado, null, 2));

// Verificar que las fechas fueron normalizadas
const fechaOriginal = objetoERPNext.fecha;
const fechaNormalizada = objetoNormalizado.fecha;

console.log('\n===========================================');
console.log('📊 RESULTADOS');
console.log('===========================================');
console.log(`✅ Pasados: ${pasados}`);
console.log(`❌ Fallidos: ${fallidos}`);
console.log(`📅 Fecha original: ${fechaOriginal}`);
console.log(`📅 Fecha normalizada: ${fechaNormalizada}`);

if (fechaNormalizada.includes('.715') && !fechaNormalizada.includes('.715809')) {
  console.log('✅ Las fechas de ERPNext se normalizaron correctamente (microsegundos → milisegundos)');
} else {
  console.log('⚠️ Verificar la normalización de microsegundos');
}

console.log('\n===========================================\n');

// Test adicional para formato SIFEN
console.log('===========================================');
console.log('🧪 TEST: Formato SIFEN (librería xmlgen)');
console.log('===========================================\n');

const fechaERPNext = '2026-02-24T15:12:58.715809';
const formatoSIFEN = formatoFechaSIFEN(fechaERPNext);

console.log('Fecha ERPNext:', fechaERPNext);
console.log('Formato SIFEN:', formatoSIFEN);
console.log('');
console.log('Verificaciones:');
console.log('  ✅ Sin microsegundos:', !/\.\d{6}/.test(formatoSIFEN) ? 'SÍ' : 'NO');
console.log('  ✅ Sin Z:', !formatoSIFEN.endsWith('Z') ? 'SÍ' : 'NO');
console.log('  ✅ Formato válido:', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(formatoSIFEN) ? 'SÍ' : 'NO');
console.log('  ✅ Date válido:', !isNaN(new Date(formatoSIFEN).getTime()) ? 'SÍ' : 'NO');

console.log('\n===========================================\n');
