# Wrapper SET API - Facturación Electrónica Paraguay

Este wrapper permite cambiar entre **Mock-SET** (desarrollo) y **SET Real** (producción) sin modificar el código del backend.

## 🚀 Uso Rápido

### Desarrollo (Mock-SET)

```bash
# .env
SIFEN_USAR_MOCK=true
SIFEN_MOCK_URL=http://localhost:8082
```

```javascript
// El código usa automáticamente el mock
const setApi = require('./services/setapi-wrapper');
await setApi.recibe(id, xml, 'test', certPath, password);
```

### Producción (SET Real)

```bash
# .env
SIFEN_USAR_MOCK=false
SIFEN_AMBIENTE=test  # o 'prod'
```

```javascript
// El código usa automáticamente la SET real
const setApi = require('./services/setapi-wrapper');
await setApi.recibe(id, xml, 'test', certPath, password);
```

## 📋 Variables de Entorno

| Variable | Descripción | Valores | Default |
|----------|-------------|---------|---------|
| `SIFEN_USAR_MOCK` | Usar Mock-SET en lugar de SET Real | `true` \| `false` | `false` |
| `SIFEN_MOCK_URL` | URL del servidor Mock-SET | URL válida | `http://localhost:8082` |
| `SIFEN_AMBIENTE` | Ambiente de SET (solo producción) | `test` \| `prod` | `test` |
| `SIFEN_TIMEOUT` | Timeout para requests HTTP | Milisegundos | `30000` |
| `SIFEN_DEBUG` | Habilitar logs de debug | `true` \| `false` | `false` |

## 🔄 Métodos Disponibles

El wrapper expone los mismos métodos que `facturacionelectronicapy-setapi`:

```javascript
const setApi = require('./services/setapi-wrapper');

// Enviar documento individual
await setApi.recibe(id, xmlSigned, ambiente, certPath, password);

// Consultar por CDC
await setApi.consulta(id, cdc, ambiente, certPath, password);

// Consultar RUC
await setApi.consultaRUC(id, ruc, ambiente, certPath, password);

// Enviar lote
await setApi.recibeLote(id, xmlArray, ambiente, certPath, password);

// Registrar evento
await setApi.evento(id, xmlEvento, ambiente, certPath, password);
```

## 🎯 ¿Cuándo usar cada modo?

### Mock-SET (`SIFEN_USAR_MOCK=true`)

✅ **Ventajas:**
- No requiere internet
- No necesita certificados válidos
- Respuestas inmediatas
- Ideal para testing y desarrollo

❌ **Limitaciones:**
- No es válido para producción
- Los CDC son simulados

### SET Real (`SIFEN_USAR_MOCK=false`)

✅ **Ventajas:**
- Totalmente funcional
- CDC oficiales de la SET
- Válido para producción

❌ **Limitaciones:**
- Requiere internet
- Necesita certificados válidos
- Latencia de red

## 📁 Archivos

```
fepy-backend/
├── config/
│   └── sifen.js              # Configuración de SIFEN
├── services/
│   ├── setapi-wrapper.js     # Wrapper principal
│   └── ...
├── .env                      # Variables de entorno (no versionar)
├── .env.example              # Ejemplo de variables (versionar)
└── ...
```

## 🔧 Configuración por Ambiente

### Desarrollo Local

```bash
# .env
SIFEN_USAR_MOCK=true
SIFEN_MOCK_URL=http://localhost:8082
SIFEN_DEBUG=true
```

### Testing en Equipo

```bash
# .env
SIFEN_USAR_MOCK=true
SIFEN_MOCK_URL=http://servidor-equipo:8082
```

### Producción

```bash
# .env
SIFEN_USAR_MOCK=false
SIFEN_AMBIENTE=prod
SIFEN_TIMEOUT=60000
```

## 🐛 Debugging

Para habilitar logs detallados:

```bash
SIFEN_DEBUG=true
```

Verás mensajes como:
```
🔧 SIFEN: Usando Mock-SET (desarrollo)
   URL: http://localhost:8082
```

o

```
🌐 SIFEN: Usando SET Real (producción)
   Ambiente: test
```

## 📝 Notas Importantes

1. **No modificar código**: El cambio entre mock y producción se hace solo con variables de entorno.

2. **Misma API**: Ambos modos usan los mismos métodos y parámetros.

3. **Certificados**: En producción, asegúrate de tener certificados válidos de la SET.

4. **Respuestas**: Las respuestas SOAP son idénticas en ambos modos (mismo schema XML).

## 🆘 Solución de Problemas

### Error: "Cannot find module 'facturacionelectronicapy-setapi'"

```bash
# Instalar librería oficial
npm install facturacionelectronicapy-setapi
```

### Error: "Mock-SET not responding"

```bash
# Verificar que el mock esté corriendo
curl http://localhost:8082/stats

# Iniciar mock-set
cd ../mock-set && npm start
```

### Error: "Certificado inválido"

```bash
# Verificar que la empresa tenga certificado cargado en la BD
# Los certificados se gestionan desde la UI o API de empresas
# NO se configuran por variables de entorno

# Ver logs del backend para más detalles
tail -f /tmp/backend.log | grep -i certificado
```

## 📚 Recursos

- [Manual Técnico SIFEN v150](../../../Manual_Técnico_Versión_150.md)
- [facturacionelectronicapy-setapi](https://github.com/marcosjara/facturacionelectronicapy-setapi)
- [SET - Servicios Web](https://ekuatia.set.gov.py/)
