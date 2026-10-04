# selectel-mcp

Локальный MCP-сервер (stdio) для управления Selectel из AI-агентов: Claude Code, Codex, opencode, pi и любых других MCP-клиентов.

- **Облачные серверы (VPS)**: список и поиск (в том числе «какой IP у сервера X»), создание, смена конфигурации (CPU/RAM), запуск, остановка, перезагрузка, снапшоты, переустановка ОС, удаление, консоль и лог загрузки.
- **Сеть**: плавающие (публичные) IP, группы безопасности (файрвол), сети, роутеры.
- **Диски**: создание, расширение, подключение и отключение, снапшоты.
- **Биллинг**: баланс, прогноз на сколько дней хватит денег, расход по проектам, услугам и ресурсам, сводка «куда уходят деньги».
- **DNS**: зоны и записи, массовое применение изменений с diff, импорт BIND-файла для переезда с другого DNS, «направь домен на сервер».
- **S3**: бакеты и объекты, загрузка и скачивание файлов, подписанные ссылки.

MCP работает только локально: агент запускает его как дочерний процесс, общение идёт через stdin/stdout, сетевой порт не открывается.

> ⚠️ Версия 0.1. Код покрыт тестами на фейковом API, но с реальным Selectel ещё не прогонялся. Начните с режима `readonly`. Если какой-то вызов падает с ошибкой API, заведите issue и приложите текст ошибки.

---

## 1. Подготовка в панели Selectel

1. **Создайте сервисного пользователя** только для MCP: «Управление доступом» → «Сервисные пользователи». Логин и пароль от своего аккаунта сюда не используйте.
2. **Выдайте минимально нужные роли.** Принцип такой: не давайте роли, которые не нужны.
   - Облачные серверы, DNS и S3: роль `member` (или `reader`, если нужен только просмотр) **на нужный проект**, а не на весь аккаунт.
   - Биллинг: роль `billing` (только просмотр финансов). Без неё работает всё, кроме `billing_*`.
3. **S3 (по желанию)**: выпустите S3-ключ для этого сервисного пользователя («Сервисные пользователи» → пользователь → «S3-ключи»).
4. Запишите **номер аккаунта** (в правом верхнем углу панели) и **ID проекта**.

## 2. Установка

```bash
git clone https://github.com/notequal21/selectel-mcp.git
cd selectel-mcp
npm install        # сам соберёт dist/
```

Нужен Node.js 20 или новее.

## 3. Где хранить пароль

Конфиги агентов (`.mcp.json`, `opencode.json`) часто лежат в репозиториях, поэтому **пароль в них не пишите**. Варианты, от лучшего к простому:

| Способ | Как |
|---|---|
| Системная связка ключей | `SELECTEL_PASSWORD_CMD="security find-generic-password -w -s selectel-mcp"` (macOS) или `"pass show selectel/mcp"` / `"secret-tool lookup service selectel-mcp"` (Linux) |
| Файл с правами 600 | `SELECTEL_PASSWORD_FILE=~/.config/selectel-mcp/password`. Если права шире, сервер откажется стартовать |
| `.env` вне репозитория | `node --env-file=/home/me/.config/selectel-mcp/.env /path/to/dist/index.js`. Пример: [`.env.example`](.env.example) |
| Переменная окружения | `SELECTEL_PASSWORD=...` прямо в конфиге агента. Годится, только если конфиг глобальный (`~/...`) и не коммитится |

Пароль, токены и S3 secret никогда не возвращаются агенту: их вырезает из ответов и сообщений об ошибках.

## 4. Подключение к агентам

Во всех примерах ниже `/abs/path/selectel-mcp` — путь к склонированному репозиторию, а секреты лежат в `~/.config/selectel-mcp/.env`.

### Claude Code

```bash
claude mcp add selectel --scope user -- \
  node --env-file=$HOME/.config/selectel-mcp/.env /abs/path/selectel-mcp/dist/index.js
```

Или через `.mcp.json` / `~/.claude.json`:

```json
{
  "mcpServers": {
    "selectel": {
      "command": "node",
      "args": ["--env-file=/home/me/.config/selectel-mcp/.env", "/abs/path/selectel-mcp/dist/index.js"],
      "env": { "SELECTEL_MCP_MODE": "readonly" }
    }
  }
}
```

Claude Code поддерживает MCP elicitation. Каждое действие, которое что-то меняет, покажет диалог подтверждения прямо в интерфейсе, и агент не сможет его обойти.

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.selectel]
command = "node"
args = ["--env-file=/home/me/.config/selectel-mcp/.env", "/abs/path/selectel-mcp/dist/index.js"]
env = { SELECTEL_MCP_MODE = "readonly" }
```

### opencode (`opencode.json` или `~/.config/opencode/opencode.json`)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "selectel": {
      "type": "local",
      "command": ["node", "--env-file=/home/me/.config/selectel-mcp/.env", "/abs/path/selectel-mcp/dist/index.js"],
      "environment": { "SELECTEL_MCP_MODE": "readonly" },
      "enabled": true
    }
  }
}
```

### pi

В pi нет встроенной поддержки MCP, она подключается расширением-адаптером (например, `pi-mcp-adapter`). Адаптеры принимают стандартный формат `mcpServers` с полями `command`, `args` и `env`, как в примере для Claude Code. Где лежит файл конфигурации, смотрите в README выбранного адаптера.

### Два подключения: «смотреть» и «менять»

Удобно подключить сервер дважды:

```json
{
  "mcpServers": {
    "selectel":       { "command": "node", "args": ["--env-file=...", ".../dist/index.js"], "env": { "SELECTEL_MCP_MODE": "readonly" } },
    "selectel-admin": { "command": "node", "args": ["--env-file=...", ".../dist/index.js"], "env": { "SELECTEL_MCP_MODE": "full" } }
  }
}
```

`selectel` работает всегда: через него можно спрашивать «какой IP у сервера», баланс и так далее. `selectel-admin` включаете, когда собираетесь что-то менять. В Claude Code это делается через `/mcp`.

## 5. Безопасность

### Режимы (`SELECTEL_MCP_MODE`)

| Режим | Что доступно |
|---|---|
| `readonly` (по умолчанию) | Только чтение. Инструменты, которые что-то меняют, **вообще не видны агенту** |
| `safe` | Плюс создание и изменение: серверы, смена конфигурации, DNS-записи, загрузка в S3. **Ничего не удаляется** |
| `full` | Плюс удаление и действия с потерей данных: удаление серверов, дисков, зон, объектов, переустановка ОС |

Режим меняется только в конфиге агента, после чего MCP нужно перезапустить. Инструмента «переключи режим» нет специально: агента нельзя уговорить, в том числе через prompt injection, повысить себе права.

### Подтверждение каждого изменения (`SELECTEL_CONFIRM`)

Любой инструмент, который что-то меняет, сначала строит **план**: что именно изменится, текущее и новое значение, предупреждения о простое, потере данных и стоимости.

- `auto` (по умолчанию): если клиент поддерживает elicitation, план показывается **вам** в диалоге и выполняется только после «Да». Иначе используется схема `token`.
- `token`: первый вызов возвращает план и одноразовый `confirm_token`. Токен живёт 5 минут, привязан к инструменту и **точным параметрам**: поменять аргументы после одобрения нельзя. Агенту в инструкциях сказано показать план вам и получить согласие. Чтобы это гарантировал сам клиент, не разрешайте мутирующие инструменты в auto-approve (см. ниже).
- `elicit`: только диалог. Если клиент его не поддерживает, действие отклоняется.
- `none`: без подтверждения для «безопасных» изменений. Удаление всё равно подтверждается.

### Защита от ошибок

- **Защищённые серверы**: `SELECTEL_PROTECTED_SERVERS=prod-db,prod-web`, или metadata `protected=true` (инструмент `server_protect`). Такие серверы нельзя удалить или переустановить, а их диски нельзя отключить.
- **Ограничения по проектам и регионам**: `SELECTEL_ALLOWED_PROJECTS`, `SELECTEL_ALLOWED_REGIONS`.
- **Лимит на создание**: не больше `SELECTEL_MAX_SERVERS_PER_CALL` серверов за вызов (по умолчанию 3).
- **Опасные операции не делаются массово**: удаление объектов S3 только по точным ключам, без удаления по префиксу. Удалить можно только пустой бакет. `dns_records_apply` никогда ничего не удаляет, удаление вынесено в отдельный `dns_records_prune`, который не трогает SOA и NS на корне зоны.
- **Предупреждения в плане**: открытие SSH или портов баз данных на `0.0.0.0/0`, IP и диски, которые остаются после удаления сервера и продолжают стоить денег, изменение NS и MX на корне зоны.
- **Локальные файлы**: загрузка в S3 и скачивание из него работают только внутри `SELECTEL_FILES_ROOT` (по умолчанию текущий каталог). Выход наружу через `..` или символические ссылки блокируется.
- **Ссылки-доступы** (консоль сервера, подписанные ссылки S3) тоже требуют подтверждения: по сути это выдача доступа.
- **Журнал действий**: каждое изменение (план, отмена, успех, ошибка) пишется в `~/.selectel-mcp/audit.jsonl` с правами 600 и без секретов.
- **Защита от prompt injection**: в инструкциях сервера агенту сказано, что имена серверов, metadata, DNS-записи и содержимое объектов — это данные, а не команды.
- **Произвольных HTTP-запросов к API нет**: только конкретные инструменты.

### Рекомендации для Claude Code

В `settings.json` разрешайте без вопросов только чтение:

```json
{
  "permissions": {
    "allow": [
      "mcp__selectel__servers_list", "mcp__selectel__server_get", "mcp__selectel__server_find",
      "mcp__selectel__billing_balance", "mcp__selectel__billing_summary", "mcp__selectel__infra_overview",
      "mcp__selectel__dns_records_list"
    ]
  }
}
```

**Не добавляйте** `mcp__selectel__*` целиком в `allow`.

## 6. Все настройки

| Переменная | По умолчанию | Описание |
|---|---|---|
| `SELECTEL_ACCOUNT_ID` | — | Номер аккаунта (обязательно) |
| `SELECTEL_USERNAME` | — | Сервисный пользователь (обязательно) |
| `SELECTEL_PASSWORD` / `_FILE` / `_CMD` | — | Пароль (обязательно, одним из способов) |
| `SELECTEL_PROJECT_ID` | — | Проект по умолчанию (id). Инструменты принимают `project` (id или имя) |
| `SELECTEL_REGION` | — | Регион (пул) по умолчанию, например `ru-9`. Инструменты принимают `region` |
| `SELECTEL_MCP_MODE` | `readonly` | `readonly` / `safe` / `full` |
| `SELECTEL_CONFIRM` | `auto` | `auto` / `elicit` / `token` / `none` |
| `SELECTEL_CONFIRM_TTL_SEC` | `300` | Время жизни `confirm_token` |
| `SELECTEL_ALLOWED_PROJECTS` | все | Через запятую, id или имена |
| `SELECTEL_ALLOWED_REGIONS` | все | Через запятую |
| `SELECTEL_PROTECTED_SERVERS` | — | Имена или id через запятую |
| `SELECTEL_PROTECTED_TAG` | `protected` | Ключ metadata или тег защиты |
| `SELECTEL_MAX_SERVERS_PER_CALL` | `3` | Лимит `count` в `server_create` |
| `SELECTEL_TOOLSETS` | все | Какие группы включить: `servers,network,volumes,billing,dns,s3`. Меньше инструментов — меньше занятого контекста агента |
| `SELECTEL_ENABLED_TOOLS` / `SELECTEL_DISABLED_TOOLS` | — | Точечно включить или выключить инструменты, поддерживается `префикс*` |
| `SELECTEL_AUDIT_LOG` | `~/.selectel-mcp/audit.jsonl` | Путь или `off` |
| `SELECTEL_FILES_ROOT` | текущий каталог | Песочница для локальных файлов (S3) |
| `SELECTEL_S3_ACCESS_KEY` / `SELECTEL_S3_SECRET_KEY` (`_FILE`/`_CMD`) | — | S3-ключ |
| `SELECTEL_S3_POOL` | `ru-1` | Пул S3 по умолчанию |
| `SELECTEL_AUTH_URL` | `https://cloud.api.selcloud.ru/identity/v3` | Keystone |
| `SELECTEL_AUTH_REGION` | `ru-1` | Регион для глобальных API (проекты, DNS) |
| `SELECTEL_HTTP_TIMEOUT_MS` | `30000` | Таймаут запросов |

## 7. Инструменты

R — только чтение, W — изменение (режимы `safe` и `full`, с подтверждением), D — удаление или потеря данных (только режим `full`, с подтверждением).

**Общее**: `selectel_status` (R; проверка доступа и текущие настройки безопасности), `projects_list` (R), `regions_list` (R), `infra_overview` (R; всё по проекту одним вызовом: серверы, IP, диски, баланс).

**Серверы**: `servers_list` (R; `region: "all"` — по всем регионам), `server_find` (R; по имени или IP), `server_get` (R; всё о сервере: IP, диски, группы безопасности), `server_create` (W), `server_action` (W; start/stop/reboot), `server_resize` (W; CPU/RAM), `server_rename` (W), `server_set_metadata` (W), `server_protect` (W), `server_unprotect` (D), `server_snapshot` (W), `server_rebuild` (D), `server_delete` (D), `server_console_log` (R), `server_console_url` (W), `server_wait` (R).
Справочники: `flavors_list`, `images_list`, `keypairs_list`, `availability_zones_list`, `volume_types_list` (R), `keypair_import` (W; только публичный ключ), `keypair_delete` (D), `flavor_create` (W; произвольная конфигурация).

**Сеть**: `networks_list`, `routers_list`, `floating_ips_list`, `security_groups_list` (R), `floating_ip_create`, `floating_ip_attach`, `floating_ip_detach`, `security_group_create`, `security_group_rule_add`, `server_security_groups_set` (W), `floating_ip_release`, `security_group_rule_delete`, `security_group_delete` (D).

**Диски**: `volumes_list`, `volume_snapshots_list` (R), `volume_create`, `volume_extend`, `volume_attach`, `volume_snapshot_create` (W), `volume_detach`, `volume_delete`, `volume_snapshot_delete` (D).

**Биллинг** (всё R): `billing_balance`, `billing_report`, `billing_summary`.

**DNS**: `dns_zones_list`, `dns_zone_get`, `dns_records_list` (R), `dns_zone_create`, `dns_record_upsert`, `dns_records_apply`, `dns_import_bind`, `dns_point_to_server` (W), `dns_zone_delete`, `dns_record_delete`, `dns_records_prune` (D).

**S3**: `s3_buckets_list`, `s3_objects_list`, `s3_object_info`, `s3_object_get_text` (R), `s3_bucket_create`, `s3_object_upload`, `s3_object_download`, `s3_object_copy`, `s3_presign_get`, `s3_presign_put` (W), `s3_bucket_delete`, `s3_object_delete` (D).

### Готовые сценарии (MCP prompts)

В Claude Code они доступны как `/mcp__selectel__<имя>`:

- `new_server` — подобрать конфигурацию под задачу, написать cloud-init и создать сервер.
- `cost_audit` — куда уходят деньги и что можно сократить. Только рекомендации, ничего не меняет.
- `dns_migrate` — перенести домен в Selectel DNS: импорт зоны, сверка, какие NS прописать у регистратора.
- `server_report` — полный отчёт по одному серверу.

### Примеры запросов агенту

- «Какой IP у сервера api-prod?»
- «Сколько у меня денег и на сколько дней хватит?»
- «Подними сервер 2 vCPU / 4 GB с Ubuntu 24.04 в ru-9, ключ my-laptop, с публичным IP и открытыми 80/443»
- «Увеличь RAM у staging до 8 GB»
- «Перенеси зону example.com: вот экспорт из Cloudflare» (вставить BIND-файл)
- «Направь app.example.com на сервер api-prod»
- «Найди всё, что стоит денег, но не используется»

## 8. Разработка

```bash
npm run build      # tsc → dist/
npm test           # vitest, фейковый API, без сети
npm run inspect    # MCP Inspector
node dist/index.js --list-tools   # какие инструменты видны при текущих env
```

Структура:

- `src/core`: конфиг, авторизация Keystone и каталог сервисов, режимы, подтверждения, журнал, удаление секретов из ответов.
- `src/tools/*`: модули с инструментами.
- `src/prompts.ts`: готовые сценарии.

Чтобы добавить новый сервис Selectel, создайте `src/tools/<name>.ts` с `defineTool({... kind, plan, run})` и добавьте его в `TOOLSETS` в `src/server.ts`. Подтверждения, режимы и журнал подключатся автоматически.
