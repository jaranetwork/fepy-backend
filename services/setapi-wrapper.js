/**
 * Wrapper para facturacionelectronicapy-setapi
 * 
 * Este módulo permite cambiar entre Mock-SET (desarrollo) y SET Real (producción)
 * mediante configuración, sin modificar el código del backend.
 * 
 * Uso:
 *   const setApi = require('./services/setapi-wrapper');
 *   
 *   // Los mismos métodos que facturacionelectronicapy-setapi
 *   await setApi.recibe(id, xml, ambiente, certPath, password);
 *   await setApi.consulta(id, cdc, ambiente, certPath, password);
 *   await setApi.consultaRUC(id, ruc, ambiente, certPath, password);
 */

const config = require('../config/sifen');

let setApi;
let configurado = false;

/**
 * Inicializa la librería según configuración
 * @returns {Object} Instancia de setApi configurada
 */
function init() {
  if (configurado && setApi) {
    return setApi;
  }

  if (config.usarMock) {
    // ========================================
    // MODO DESARROLLO: Usar Mock-SET
    // ========================================
    console.log('🔧 SIFEN: Usando Mock-SET (desarrollo)');
    console.log(`   URL: ${config.mockUrl}`);
    
    setApi = require('../../mock-set/setapi-mock').default;
    
    // Configurar mock con URL personalizada
    setApi.configure({
      mockUrl: config.mockUrl,
      timeout: config.timeout,
      debug: config.debug
    });
    
  } else {
    // ========================================
    // MODO PRODUCCIÓN: Usar SET Real
    // ========================================
    console.log('🌐 SIFEN: Usando SET Real (producción)');
    console.log(`   Ambiente: ${process.env.SIFEN_AMBIENTE || 'test'}`);
    
    setApi = require('facturacionelectronicapy-setapi').default;
  }

  configurado = true;
  return setApi;
}

/**
 * Obtiene la instancia de setApi (inicializa si es necesario)
 */
function getInstance() {
  return init();
}

/**
 * Verifica si está usando Mock-SET
 * @returns {boolean} true si usa mock, false si usa SET real
 */
function esMock() {
  return config.usarMock;
}

/**
 * Obtiene configuración actual
 * @returns {Object} Configuración de SIFEN
 */
function getConfig() {
  return config;
}

// ========================================
// Exportar métodos de setApi
// ========================================
// Los métodos se resuelven dinámicamente para soportar ambas implementaciones

module.exports = {
  // Inicialización y configuración
  init,
  getInstance,
  esMock,
  getConfig,

  // Métodos de setApi (se resuelven dinámicamente)
  get recibe() {
    return init().recibe;
  },
  
  get consulta() {
    return init().consulta;
  },
  
  get consultaRUC() {
    return init().consultaRUC;
  },
  
  get recibeLote() {
    return init().recibeLote;
  },
  
  get evento() {
    return init().evento;
  },
  
  get configure() {
    return init().configure;
  }
};
