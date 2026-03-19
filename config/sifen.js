/**
 * Configuración del Sistema SIFEN
 * 
 * Permite cambiar entre Mock-SET (desarrollo) y SET Real (producción)
 * mediante variables de entorno.
 */

module.exports = {
  /**
   * Usar Mock-SET en lugar de SET Real
   * 
   * Para producción, establecer en 'false' o dejar sin definir
   */
  usarMock: process.env.SIFEN_USAR_MOCK === 'true',

  /**
   * URL del servidor Mock-SET
   * 
   * Por defecto: http://localhost:8082
   */
  mockUrl: process.env.SIFEN_MOCK_URL || 'http://127.0.0.1:8082',

  /**
   * URL de producción para SET Real
   * 
   * No modificar - URLs oficiales de la SET
   */
  produccion: {
    recibe: 'https://ekuatia.set.gov.py/de/ws/sync/recibe.wsdl',
    recibeLote: 'https://ekuatia.set.gov.py/de/ws/async/recibe-lote.wsdl',
    consulta: 'https://ekuatia.set.gov.py/de/ws/consultas/consulta.wsdl',
    consultaRUC: 'https://ekuatia.set.gov.py/de/ws/consultas/consulta-ruc.wsdl',
    evento: 'https://ekuatia.set.gov.py/de/ws/eventos/evento.wsdl'
  },

  /**
   * URL de testing para SET Real (ambiente test)
   * 
   * No modificar - URLs oficiales de la SET para testing
   */
  test: {
    recibe: 'https://sifen-test.set.gov.py/de/ws/sync/recibe.wsdl',
    recibeLote: 'https://sifen-test.set.gov.py/de/ws/async/recibe-lote.wsdl',
    consulta: 'https://sifen-test.set.gov.py/de/ws/consultas/consulta.wsdl',
    consultaRUC: 'https://sifen-test.set.gov.py/de/ws/consultas/consulta-ruc.wsdl',
    evento: 'https://sifen-test.set.gov.py/de/ws/eventos/evento.wsdl'
  },

  /**
   * Timeout para requests HTTP (en milisegundos)
   */
  timeout: parseInt(process.env.SIFEN_TIMEOUT, 10) || 30000,

  /**
   * Habilitar logs de debug
   */
  debug: process.env.SIFEN_DEBUG === 'true'
};
