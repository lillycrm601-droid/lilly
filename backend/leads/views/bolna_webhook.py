import logging
from django.conf import settings
from django.contrib.contenttypes.models import ContentType
from django.utils import timezone
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from common.models import Comment
from common.tasks import set_rls_context
from leads.models import Lead

logger = logging.getLogger(__name__)


def classify_with_gemini(transcript, api_key):
    import requests
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
    headers = {"Content-Type": "application/json"}
    prompt = (
        "You are an AI assistant analyzing a call transcript between a sales agent and a lead. "
        "Based on the conversation transcript, classify the lead rating as one of the following exact options:\n"
        "- 'HOT' (high interest, wants to purchase/next steps/demo/pricing/meeting)\n"
        "- 'WARM' (some interest, asked questions, but not immediate or needs follow-up)\n"
        "- 'COLD' (no interest, told not to call back, or wrong number)\n\n"
        "Output ONLY the classification word: HOT, WARM, or COLD. Do not include any explanation or other characters.\n\n"
        f"Transcript:\n{transcript}"
    )
    payload = {
        "contents": [{"parts": [{"text": prompt}]}]
    }
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=10)
        if response.status_code == 200:
            res = response.json()
            text = res['candidates'][0]['content']['parts'][0]['text'].strip().upper()
            if text in ["HOT", "WARM", "COLD"]:
                return text
    except Exception as e:
        logger.error(f"Error classifying with Gemini: {e}")
    return None


def classify_with_openai(transcript, api_key):
    import requests
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    prompt = (
        "You are an AI assistant analyzing a call transcript between a sales agent and a lead. "
        "Based on the conversation transcript, classify the lead rating as one of the following exact options:\n"
        "- 'HOT' (high interest, wants to purchase/next steps/demo/pricing/meeting)\n"
        "- 'WARM' (some interest, asked questions, but not immediate or needs follow-up)\n"
        "- 'COLD' (no interest, told not to call back, or wrong number)\n\n"
        "Output ONLY the classification word: HOT, WARM, or COLD. Do not include any explanation or other characters.\n\n"
        f"Transcript:\n{transcript}"
    )
    payload = {
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.0,
        "max_tokens": 5,
    }
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=10)
        if response.status_code == 200:
            res = response.json()
            text = res['choices'][0]['message']['content'].strip().upper()
            if text in ["HOT", "WARM", "COLD"]:
                return text
    except Exception as e:
        logger.error(f"Error classifying with OpenAI: {e}")
    return None


def search_payload_for_rating(data):
    valid_ratings = {"HOT", "WARM", "COLD"}
    extracted_data = data.get("extracted_data") or {}
    
    for key in ["rating", "lead_rating", "classification", "qualification", "lead_quality", "status"]:
        val = extracted_data.get(key) or data.get(key)
        if isinstance(val, str):
            val_upper = val.strip().upper()
            if val_upper in valid_ratings:
                return val_upper

    def _search(obj):
        if isinstance(obj, dict):
            for k, v in obj.items():
                if k.lower() in ["rating", "lead_rating", "classification", "qualification", "lead_quality"]:
                    if isinstance(v, str) and v.upper().strip() in valid_ratings:
                        return v.upper().strip()
                res = _search(v)
                if res:
                    return res
        elif isinstance(obj, list):
            for item in obj:
                res = _search(item)
                if res:
                    return res
        return None

    return _search(data)


def local_heuristic_classification(transcript):
    if not transcript:
        return "WARM"
    
    t_lower = transcript.lower()
    cold_keywords = ["not interested", "wrong number", "unsubscribe", "stop calling", "remove me", "don't call"]
    hot_keywords = ["interested", "buy", "purchase", "pricing", "sign up", "demo", "meeting", "schedule", "call me back"]
    
    if any(kw in t_lower for kw in cold_keywords):
        return "COLD"
    if any(kw in t_lower for kw in hot_keywords):
        return "HOT"
    return "WARM"


class BolnaWebhookView(APIView):
    """
    Public webhook endpoint for receiving call status callbacks from Bolna Voice AI.
    """
    permission_classes = (AllowAny,)
    authentication_classes = []

    def post(self, request, *args, **kwargs):
        data = request.data
        logger.info(f"Received Bolna webhook: {data}")

        # Extract user_data nested or root
        user_data = data.get("user_data") or {}
        if not user_data:
            for key in ["execution", "call", "payload"]:
                if isinstance(data.get(key), dict):
                    user_data = data[key].get("user_data") or {}
                    if user_data:
                        break

        lead_id = user_data.get("lead_id") or data.get("lead_id") or request.query_params.get("lead_id")
        org_id = user_data.get("org_id") or data.get("org_id") or request.query_params.get("org_id")

        if not lead_id or not org_id:
            phone = data.get("recipient_phone_number")
            logger.warning(f"Bolna webhook missing lead_id or org_id. Phone: {phone}")
            return Response(
                {"error": "lead_id and org_id are required in user_data or query parameters"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Set RLS context for database isolation
        set_rls_context(org_id)

        try:
            lead = Lead.objects.get(id=lead_id)
        except Lead.DoesNotExist:
            logger.error(f"Lead {lead_id} not found in org {org_id}")
            return Response({"error": "Lead not found"}, status=status.HTTP_404_NOT_FOUND)

        call_status = data.get("status", "").lower()
        duration = data.get("conversation_duration", "N/A")
        error_msg = data.get("error_message")

        # Create audit comment and update lead
        lead_content_type = ContentType.objects.get_for_model(Lead)

        if call_status == "completed":
            transcript = data.get("transcript", "")
            
            # 1. Try Gemini
            gemini_key = getattr(settings, "GEMINI_API_KEY", "")
            classification = None
            if gemini_key and transcript:
                classification = classify_with_gemini(transcript, gemini_key)
            
            # 2. Try OpenAI
            openai_key = getattr(settings, "OPENAI_API_KEY", "")
            if not classification and openai_key and transcript:
                classification = classify_with_openai(transcript, openai_key)
            
            # 3. Try Bolna extraction data
            if not classification:
                classification = search_payload_for_rating(data)
                
            # 4. Try Local heuristics
            if not classification:
                classification = local_heuristic_classification(transcript)

            lead.rating = classification
            lead.save()

            comment_text = f"Bolna AI Call Completed. Duration: {duration}s. Classification: {classification}."
            Comment.objects.create(
                content_type=lead_content_type,
                object_id=lead.id,
                comment=comment_text[:255],
                org=lead.org,
            )

            # Append transcript to lead description (which is a TextField)
            transcript_section = (
                f"\n\n--- Bolna AI Call Log ({timezone.now().strftime('%Y-%m-%d %H:%M')}) ---\n"
                f"Status: {call_status}\n"
                f"Duration: {duration}s\n"
                f"Rating: {classification}\n"
                f"Transcript:\n{transcript}\n"
                "---------------------------------"
            )
            if lead.description:
                lead.description += transcript_section
            else:
                lead.description = transcript_section.strip()
            lead.save()

        elif call_status in ["failed", "no-answer", "busy"]:
            comment_text = f"Bolna AI Call failed. Status: {call_status}. Error: {error_msg or 'N/A'}."
            Comment.objects.create(
                content_type=lead_content_type,
                object_id=lead.id,
                comment=comment_text[:255],
                org=lead.org,
            )
        else:
            comment_text = f"Bolna AI Call Status Update: {call_status}."
            Comment.objects.create(
                content_type=lead_content_type,
                object_id=lead.id,
                comment=comment_text[:255],
                org=lead.org,
            )

        return Response({"status": "processed"}, status=status.HTTP_200_OK)
