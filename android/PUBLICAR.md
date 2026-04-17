# Finno — Guia de Publicação na Play Store

**Package:** `br.com.finno.app`
**URL:** `https://app-fino.web.app`

---

## PASSO 1 — Gerar a keystore (uma única vez)

Execute fora da pasta `android/`, em local seguro:

```bash
keytool -genkey -v \
  -keystore finno-release.jks \
  -alias finno \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

O comando pede: nome, organização, cidade, estado, país, senha do keystore, senha da chave.

> Guardar `finno-release.jks` fora do repositório. Se perder, não publica atualizações.

---

## PASSO 2 — Obter o SHA-256 da keystore

```bash
keytool -list -v \
  -keystore finno-release.jks \
  -alias finno
```

Na saída, copiar o valor de **"SHA256:"**:
```
SHA256: AB:CD:EF:12:34:56:...
```

---

## PASSO 3 — Colar SHA-256 no assetlinks.json

Arquivo: `.well-known/assetlinks.json`

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "br.com.finno.app",
    "sha256_cert_fingerprints": [
      "AB:CD:EF:12:34:56:..."
    ]
  }
}]
```

Depois fazer deploy:

```bash
firebase deploy --only hosting
```

Verificar: `https://app-fino.web.app/.well-known/assetlinks.json`

---

## PASSO 4 — Configurar credenciais de assinatura

```bash
cd android/
cp keystore.properties.example keystore.properties
```

Editar `keystore.properties`:

```properties
storeFile=../finno-release.jks
storePassword=SENHA_DO_KEYSTORE
keyAlias=finno
keyPassword=SENHA_DA_CHAVE
```

> `keystore.properties` está no `.gitignore` — nunca sobe pro git.

---

## PASSO 5 — Gerar o Android App Bundle

```bash
cd android/
./gradlew bundleRelease
```

**No Windows** (se não tiver gradlew executável):
```bash
gradle bundleRelease
```

O arquivo gerado:
```
android/app/build/outputs/bundle/release/app-release.aab
```

---

## PASSO 6 — Validar TWA no celular

### Instalar para teste:
```bash
./gradlew installDebug
```

### Sinal de que TWA está funcionando:
- App abre **sem barra de URL** do Chrome → TWA verificado ✅
- App abre **com barra de URL** → assetlinks.json não verificado ainda

### Verificador oficial:
https://developers.google.com/digital-asset-links/tools/generator

Preencher:
- Hosting site domain: `app-fino.web.app`
- App package name: `br.com.finno.app`
- App package fingerprint: (SHA-256 do Passo 2)

---

## PASSO 7 — Upload na Play Store

### 7.1 — Criar app no Play Console
1. Acessar https://play.google.com/console
2. **Criar app** → Nome: "Finno" → Categoria: Finanças pessoais
3. Package name: `br.com.finno.app`

### 7.2 — Ativar Play App Signing (obrigatório para .aab)
1. **Configuração → Assinatura de app**
2. Escolher **"Chave gerenciada pelo Google"**
3. Confirmar

> A Google guarda a chave de distribuição. Sua keystore vira "upload key" — se perder, consegue substituir.

### 7.3 — Criar teste interno
1. **Testes → Teste interno → Criar nova versão**
2. Fazer upload do `app-release.aab`
3. Adicionar e-mails de testadores
4. Publicar

### 7.4 — Testar no celular via Internal Testing
1. Abrir link de opt-in no celular do testador
2. Instalar via Play Store
3. Verificar que abre sem barra de URL

---

## PASSO 8 — Publicar na produção

Após testes aprovados:

1. **Produção → Criar nova versão**
2. Upload do mesmo `.aab`
3. Preencher ficha da loja (obrigatório):
   - Descrição curta (máx 80 chars)
   - Descrição completa (máx 4000 chars)
   - Ícone 512×512 PNG
   - Feature graphic 1024×500 PNG
   - Mínimo 2 screenshots de telefone
4. Política de privacidade (URL obrigatória)
5. Submeter para revisão (1–3 dias úteis)

---

## Checklist final

- [ ] `finno-release.jks` gerada e salva em local seguro
- [ ] SHA-256 copiado para `.well-known/assetlinks.json`
- [ ] `firebase deploy --only hosting` executado
- [ ] `https://app-fino.web.app/.well-known/assetlinks.json` acessível
- [ ] `keystore.properties` criado e preenchido
- [ ] `./gradlew bundleRelease` executou sem erro
- [ ] `app-release.aab` gerado em `app/build/outputs/bundle/release/`
- [ ] App criado no Play Console com package `br.com.finno.app`
- [ ] Play App Signing ativado
- [ ] .aab enviado para Internal Testing
- [ ] Testado no celular — sem barra de URL ✅
- [ ] Ícone 512×512 e feature graphic 1024×500 prontos
- [ ] Mínimo 2 screenshots prontos
- [ ] URL da política de privacidade disponível
- [ ] Versão de produção submetida para revisão

---

## Imagens necessárias para a Play Store

| Asset | Tamanho | Formato |
|---|---|---|
| Ícone do app | 512×512 | PNG, sem transparência |
| Feature graphic | 1024×500 | PNG ou JPG |
| Screenshots (mín. 2) | 9:16 ou 16:9 | PNG ou JPG |
| Ícones mipmap (Android < 8) | ver abaixo | PNG |

### Ícones mipmap PNG (para dispositivos antigos):
- `mipmap-mdpi/ic_launcher.png` → 48×48
- `mipmap-hdpi/ic_launcher.png` → 72×72
- `mipmap-xhdpi/ic_launcher.png` → 96×96
- `mipmap-xxhdpi/ic_launcher.png` → 144×144
- `mipmap-xxxhdpi/ic_launcher.png` → 192×192

> Gerar a partir do ícone 512×512 usando Android Studio → Image Asset Studio,
> ou online: https://romannurik.github.io/AndroidAssetStudio/icons-launcher.html
