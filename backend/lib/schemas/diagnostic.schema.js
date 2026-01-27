module.exports = {
    "$id": "https://example.com/schemas/diagnostic.schema.json",
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["lesson", "questions"],
    "properties": {
        "lesson": {
            "type": "object",
            "required": ["title", "explanation", "images"],
            "properties": {
                "title": { "type": "string" },
                "explanation": { "type": "string" },
                "images": { "type": "array", "items": { "type": "string" } }
            },
            "additionalProperties": true
        },
        "questions": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "required": [
                    "id", "type",
                    "content_cn", "content_en",
                    "options", "answer_cn", "answer_en",
                    "explanation_cn", "explanation_en",
                    "knowledge_point_id"
                ],
                "properties": {
                    "id": { "anyOf": [{ "type": "integer" }, { "type": "string" }] },
                    "type": { "type": "string", "enum": ["mcq"] },
                    "content_cn": { "type": "string" },
                    "content_en": { "type": "string" },
                    "options": {
                        "type": "object",
                        "properties": {
                            "zh": { "type": "array", "items": { "type": "string" }, "minItems": 4, "maxItems": 4 },
                            "en": { "type": "array", "items": { "type": "string" }, "minItems": 4, "maxItems": 4 }
                        },
                        "required": ["zh", "en"],
                        "additionalProperties": false
                    },
                    "answer_cn": { "type": "string" },
                    "answer_en": { "type": "string" },
                    "explanation_cn": { "type": "string" },
                    "explanation_en": { "type": "string" },
                    "knowledge_point_id": { "type": "integer" },
                    "content_options_hash": { "type": "string" }
                },
                "additionalProperties": true
            }
        }
    },
    "additionalProperties": true
};
