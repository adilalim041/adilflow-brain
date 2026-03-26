# AdilFlow Brain — Инструкция по развёртыванию

## ЧТО ЭТО
Мозг — центральный сервис всей медиа-сети AdilFlow.
Хранит все статьи, классифицирует через ИИ, раздаёт Генератору и Публикатору.

## КОМПОНЕНТЫ
- **Supabase** — бесплатная PostgreSQL база + pgvector + визуальный интерфейс
- **Railway** — Node.js API сервер (как наш Image Service)

---

## ШАГ 1: СОЗДАТЬ SUPABASE ПРОЕКТ

1. Зайди на https://supabase.com → Sign Up (через GitHub)
2. Нажми "New Project"
3. Название: `adilflow-brain`
4. Пароль базы: придумай и ЗАПОМНИ
5. Регион: выбери ближайший (Frankfurt или Singapore)
6. Подожди 2 минуты пока создастся

**Скопируй и сохрани:**
- Project URL (выглядит как `https://xxxxx.supabase.co`)
- Service Role Key (Settings → API → service_role → Reveal)

⚠️ Service Role Key — это полный доступ к базе. НЕ коммить в GitHub.

---

## ШАГ 2: СОЗДАТЬ ТАБЛИЦЫ

1. В Supabase → SQL Editor (левое меню)
2. Нажми "New Query"
3. Скопируй ВЕСЬ текст из файла `schema.sql`
4. Нажми "Run"
5. Должно быть "Success" — таблицы articles, sources, niches, api_keys созданы

**Проверка:** зайди в Table Editor → должны быть 4 таблицы.
В таблице `niches` должны быть 2 записи: ai_news и health_medicine.

---

## ШАГ 3: СОЗДАТЬ GITHUB РЕПОЗИТОРИЙ

1. GitHub → New Repository → `adilflow-brain`
2. Загрузи 3 файла: `server.js`, `package.json`, `schema.sql`
3. НЕ загружай файлы с ключами!

---

## ШАГ 4: ЗАДЕПЛОИТЬ НА RAILWAY

1. Railway.app → New Project → Deploy from GitHub Repo
2. Выбери `adilflow-brain`
3. Railway начнёт деплоить

**Добавь переменные окружения (Variables):**

```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbG...  (service_role key из шага 1)
OPENAI_API_KEY=sk-...           (твой OpenAI ключ, тот же что в n8n)
API_KEY=придумай-длинный-ключ   (любая строка, это пароль для сервисов)
PORT=3001
```

4. Railway задеплоит автоматически
5. Скопируй URL сервиса (типа `https://adilflow-brain-production.up.railway.app`)

---

## ШАГ 5: ПРОВЕРКА

Открой в браузере URL Railway сервиса. Должно показать:
```json
{"service":"AdilFlow Brain","version":"1.0.0","status":"online"}
```

Проверь health:
```
https://adilflow-brain-production.up.railway.app/health
```

---

## ШАГ 6: ПОДКЛЮЧИТЬ ПАРСЕР

В файле парсера (parser.py) установи переменные:
```
BRAIN_URL=https://adilflow-brain-production.up.railway.app
BRAIN_API_KEY=тот-же-ключ-что-в-Railway-API_KEY
```

Запусти парсер — он отправит статьи в Мозг.
В Supabase → Table Editor → articles — увидишь новые записи.

---

## ШАГ 7: КЛАССИФИКАЦИЯ

Вызови классификацию вручную (через браузер или curl):
```
POST https://adilflow-brain-production.up.railway.app/api/classify
Headers: Authorization: Bearer твой-API_KEY
Body: { "niche": "health_medicine", "limit": 20 }
```

GPT-4o-mini оценит каждую статью 1-10.
В Supabase увидишь: relevance_score заполнен, статус = classified или rejected.

---

## СТОИМОСТЬ
- Supabase Free: 500MB база, 50K запросов/месяц — хватит на годы
- Railway: ~$5/мес (общий с Image Service)
- GPT-4o-mini классификация: ~$0.50/мес (20 статей * 30 дней * $0.001)

---

## ЧТО ДАЛЬШЕ
После развёртывания Мозга:
1. Парсер отправляет статьи → видишь в Supabase
2. Классификация отсеивает мусор → топ статьи готовы
3. Генератор забирает топ → создаёт контент → Railway Image Service
4. Публикатор забирает готовое → Telegram/Instagram
