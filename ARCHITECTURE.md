# AdilFlow Brain — Сервис 2

## Роль
Центральная база данных и API всей медиа-сети.
Все сервисы общаются только через Мозг.

## Компоненты
1. **Supabase** — PostgreSQL + pgvector (хостинг БД, бесплатно)
2. **Railway API** — Node.js Express (логика, ИИ вызовы)

## Потоки данных

### Парсер → Мозг
```
POST /api/articles/batch
Body: { articles: [...], niche: "health_medicine" }

Мозг:
1. Дедупликация по url_hash (точный дубль)
2. Дедупликация по embedding (семантический дубль, pgvector)
3. Сохранение новых статей со статусом "raw"
4. Ответ: { new: 15, duplicates: 397 }
```

### Мозг → Классификация (внутренний процесс)
```
Cron каждые 30 мин внутри Railway API:
1. Берёт статьи со статусом "raw"
2. Ensemble AI: GPT-4o-mini + Gemini Flash оценивают 1-10
3. Среднее > 7 → статус "classified"
4. Среднее < 4 → статус "rejected"
5. Остальные → ждут больше данных
```

### Генератор → Мозг
```
GET /api/articles/ready?niche=health_medicine&limit=5

Мозг возвращает топ-5 статей:
- Отсортированы по relevance_score
- Статус "classified" → меняется на "processing"
- Включает: raw_title, raw_text, images[], has_usable_media

POST /api/articles/:id/generated
Body: { headline, headline2, body, conclusion, image_url, template_id }
Статус: "processing" → "ready"
```

### Публикатор → Мозг
```
GET /api/articles/ready?niche=health_medicine&channel=telegram
POST /api/articles/:id/published
Body: { channel: "telegram", message_id: 12345 }
Статус: "ready" → "published"
```
