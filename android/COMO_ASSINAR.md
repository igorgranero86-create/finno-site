# Como gerar o .aab assinado para a Play Store

## Pré-requisitos
- Android Studio instalado (ou só o JDK 17+)
- Conta Google Play Console criada

---

## Passo 1 — Gerar keystore (só uma vez)

```bash
keytool -genkey -v \
  -keystore finno-release.jks \
  -alias finno \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

Salvar finno-release.jks em local seguro fora do repositório.
NUNCA subir o .jks para o git.

---

## Passo 2 — Obter o SHA-256 do certificado

```bash
keytool -list -v \
  -keystore finno-release.jks \
  -alias finno
```

Copiar o valor de "SHA256:" (formato: AA:BB:CC:...) e colar em:
  .well-known/assetlinks.json → campo "sha256_cert_fingerprints"

Depois fazer deploy do Firebase Hosting:
```bash
firebase deploy --only hosting
```

Verificar em:  https://app-fino.web.app/.well-known/assetlinks.json

---

## Passo 3 — Configurar variáveis de ambiente (opcional mas recomendado)

```bash
export FINNO_KEYSTORE_PATH=/caminho/para/finno-release.jks
export FINNO_STORE_PASSWORD=senha_do_keystore
export FINNO_KEY_ALIAS=finno
export FINNO_KEY_PASSWORD=senha_da_chave
```

Ou editar diretamente em app/build.gradle (bloco signingConfigs.release).

---

## Passo 4 — Gerar o Android App Bundle (.aab)

```bash
cd android/
./gradlew bundleRelease
```

O arquivo gerado fica em:
  android/app/build/outputs/bundle/release/app-release.aab

---

## Passo 5 — Play App Signing (recomendado fortemente)

A Google gerencia a chave final de distribuição.
Você envia apenas o .aab assinado com sua upload key.

1. No Play Console → seu app → Setup → App signing
2. Escolher "Use Google-managed key" (padrão)
3. Fazer upload do .aab no Play Console
4. A Google assina com a chave dela para distribuição

Benefício: se perder o keystore, a Google ainda consegue distribuir o app.

---

## Passo 6 — Verificar Digital Asset Links

Após deploy do assetlinks.json e publicação do app:

https://developers.google.com/digital-asset-links/tools/generator

Preencher:
- Hosting site domain: app-fino.web.app
- App package name: br.com.finno.app
- App package fingerprint: (SHA-256 do step 2)

Se retornar "success", a verificação TWA está OK.
O app abrirá sem barra de URL do Chrome.
