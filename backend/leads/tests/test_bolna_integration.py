import json
from unittest.mock import patch, MagicMock
import pytest
from django.contrib.contenttypes.models import ContentType
from common.models import Comment
from leads.models import Lead
from leads.tasks import trigger_bolna_call
from leads.views.bolna_webhook import (
    local_heuristic_classification,
    search_payload_for_rating,
)
from crm.celery import app as celery_app


@pytest.fixture(autouse=True)
def configure_celery():
    """
    Force Celery to run in eager mode synchronously for all tests in this module.
    This prevents Celery from attempting to connect to a real Redis server.
    """
    original_always_eager = celery_app.conf.task_always_eager
    original_broker_url = celery_app.conf.broker_url
    original_backend = celery_app.conf.result_backend

    celery_app.conf.update(
        task_always_eager=True,
        always_eager=True,
        broker_url="memory://",
        result_backend="cache+memory://"
    )
    yield
    celery_app.conf.update(
        task_always_eager=original_always_eager,
        always_eager=original_always_eager,
        broker_url=original_broker_url,
        result_backend=original_backend
    )


@pytest.fixture
def test_lead(db, admin_user, org_a):
    # Patch the task call during Lead creation in fixture to avoid triggering unwanted tasks
    with patch("leads.tasks.trigger_bolna_call.delay") as mock_delay:
        return Lead.objects.create(
            first_name="Test",
            last_name="Lead",
            email="testlead@example.com",
            phone="+1234567890",
            created_by=admin_user,
            org=org_a,
        )


@pytest.mark.django_db
class TestBolnaSignalAndTask:

    @patch("leads.tasks.trigger_bolna_call.delay")
    def test_lead_created_triggers_call_signal(self, mock_trigger, admin_user, org_a):
        lead = Lead.objects.create(
            first_name="Signal",
            last_name="Lead",
            email="signal@example.com",
            phone="+9876543210",
            created_by=admin_user,
            org=org_a,
        )
        mock_trigger.assert_called_once_with(lead.id, str(org_a.id))

    @patch("leads.tasks.trigger_bolna_call.delay")
    def test_lead_created_without_phone_does_not_trigger(self, mock_trigger, admin_user, org_a):
        Lead.objects.create(
            first_name="NoPhone",
            last_name="Lead",
            email="nophone@example.com",
            created_by=admin_user,
            org=org_a,
        )
        mock_trigger.assert_not_called()

    @patch("requests.post")
    @patch("django.conf.settings.BOLNA_API_KEY", "test-key")
    @patch("django.conf.settings.BOLNA_AGENT_ID", "test-agent")
    @patch("django.conf.settings.BOLNA_FROM_PHONE", "+111111111")
    def test_trigger_bolna_call_task_success(self, mock_post, test_lead, org_a):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"execution_id": "exec-12345"}
        mock_post.return_value = mock_response

        # Execute task synchronously
        result = trigger_bolna_call(test_lead.id, str(org_a.id))
        
        assert result is True
        mock_post.assert_called_once()
        args, kwargs = mock_post.call_args
        assert args[0] == "https://api.bolna.ai/call"
        assert kwargs["json"]["agent_id"] == "test-agent"
        assert kwargs["json"]["recipient_phone_number"] == test_lead.phone
        assert kwargs["json"]["user_data"]["lead_id"] == str(test_lead.id)

        # Check comment was created
        lead_ct = ContentType.objects.get_for_model(Lead)
        comment = Comment.objects.filter(
            content_type=lead_ct,
            object_id=test_lead.id,
            org=org_a
        ).first()
        assert comment is not None
        assert "Initiated immediate Bolna AI call" in comment.comment
        assert "exec-12345" in comment.comment


@pytest.mark.django_db
class TestBolnaWebhookView:

    def test_webhook_missing_lead_or_org(self, admin_client):
        response = admin_client.post(
            "/api/public/leads/bolna-webhook/",
            {"status": "completed"},
            format="json"
        )
        assert response.status_code == 400
        assert "error" in response.json()

    @patch("requests.post")
    @patch("django.conf.settings.GEMINI_API_KEY", "gemini-key")
    def test_webhook_completed_with_gemini_success(self, mock_post, admin_client, test_lead, org_a):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "candidates": [{
                "content": {
                    "parts": [{"text": "HOT"}]
                }
            }]
        }
        mock_post.return_value = mock_response

        payload = {
            "status": "completed",
            "conversation_duration": 45,
            "transcript": "Hello, yes I am very interested and would love to buy this product.",
            "user_data": {
                "lead_id": test_lead.id,
                "org_id": str(org_a.id)
            }
        }

        response = admin_client.post(
            "/api/public/leads/bolna-webhook/",
            payload,
            format="json"
        )
        assert response.status_code == 200
        assert response.json() == {"status": "processed"}

        # Verify lead updated
        test_lead.refresh_from_db()
        assert test_lead.rating == "HOT"
        assert "I am very interested" in test_lead.description

        # Verify comment
        lead_ct = ContentType.objects.get_for_model(Lead)
        comment = Comment.objects.filter(
            content_type=lead_ct,
            object_id=test_lead.id,
            comment__icontains="Bolna AI Call Completed"
        ).first()
        assert comment is not None
        assert "Classification: HOT" in comment.comment

    @patch("requests.post")
    @patch("django.conf.settings.OPENAI_API_KEY", "openai-key")
    def test_webhook_completed_with_openai_success(self, mock_post, admin_client, test_lead, org_a):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "choices": [{
                "message": {"content": "COLD"}
            }]
        }
        mock_post.return_value = mock_response

        payload = {
            "status": "completed",
            "conversation_duration": 20,
            "transcript": "Wrong number. Please stop calling me.",
            "user_data": {
                "lead_id": test_lead.id,
                "org_id": str(org_a.id)
            }
        }

        response = admin_client.post(
            "/api/public/leads/bolna-webhook/",
            payload,
            format="json"
        )
        assert response.status_code == 200

        # Verify lead updated
        test_lead.refresh_from_db()
        assert test_lead.rating == "COLD"
        assert "Wrong number" in test_lead.description

    def test_webhook_completed_fallback_bolna_rating(self, admin_client, test_lead, org_a):
        payload = {
            "status": "completed",
            "conversation_duration": 30,
            "extracted_data": {
                "rating": "WARM"
            },
            "user_data": {
                "lead_id": test_lead.id,
                "org_id": str(org_a.id)
            }
        }

        response = admin_client.post(
            "/api/public/leads/bolna-webhook/",
            payload,
            format="json"
        )
        assert response.status_code == 200

        # Verify lead updated
        test_lead.refresh_from_db()
        assert test_lead.rating == "WARM"

    def test_webhook_completed_fallback_heuristics(self, admin_client, test_lead, org_a):
        payload = {
            "status": "completed",
            "conversation_duration": 30,
            "transcript": "No, I am not interested at all, unsubscribe me.",
            "user_data": {
                "lead_id": test_lead.id,
                "org_id": str(org_a.id)
            }
        }

        response = admin_client.post(
            "/api/public/leads/bolna-webhook/",
            payload,
            format="json"
        )
        assert response.status_code == 200

        test_lead.refresh_from_db()
        assert test_lead.rating == "COLD"

    def test_webhook_failed_status(self, admin_client, test_lead, org_a):
        payload = {
            "status": "failed",
            "error_message": "Recipient did not answer.",
            "user_data": {
                "lead_id": test_lead.id,
                "org_id": str(org_a.id)
            }
        }

        response = admin_client.post(
            "/api/public/leads/bolna-webhook/",
            payload,
            format="json"
        )
        assert response.status_code == 200

        # Rating should not change
        test_lead.refresh_from_db()
        assert test_lead.rating is None

        # Verify comment
        lead_ct = ContentType.objects.get_for_model(Lead)
        comment = Comment.objects.filter(
            content_type=lead_ct,
            object_id=test_lead.id,
            comment__icontains="Bolna AI Call failed"
        ).first()
        assert comment is not None
        assert "Error: Recipient did not answer" in comment.comment


def test_local_heuristic_classification():
    assert local_heuristic_classification("I would love to buy a demo") == "HOT"
    assert local_heuristic_classification("please stop calling wrong number") == "COLD"
    assert local_heuristic_classification("random chat text") == "WARM"


def test_search_payload_for_rating():
    data = {"extracted_data": {"qualification": "HOT"}}
    assert search_payload_for_rating(data) == "HOT"

    data = {"lead_rating": "warm"}
    assert search_payload_for_rating(data) == "WARM"

    data = {"something": {"rating": "COLD"}}
    assert search_payload_for_rating(data) == "COLD"


@pytest.mark.django_db
class TestTriggerLeadCallView:

    @patch("django.conf.settings.BOLNA_API_KEY", "test-key")
    @patch("django.conf.settings.BOLNA_AGENT_ID", "test-agent")
    @patch("leads.tasks.trigger_bolna_call.delay")
    def test_trigger_call_success(self, mock_trigger, admin_client, test_lead, org_a):
        response = admin_client.post(
            f"/api/leads/{test_lead.id}/trigger-call/",
            format="json"
        )
        assert response.status_code == 200
        assert response.json() == {"error": False, "message": "Bolna AI call triggered successfully."}
        mock_trigger.assert_called_once_with(str(test_lead.id), str(org_a.id))

    @patch("django.conf.settings.BOLNA_API_KEY", "")
    @patch("django.conf.settings.BOLNA_AGENT_ID", "")
    @patch("leads.tasks.trigger_bolna_call.delay")
    def test_trigger_call_unconfigured_sandbox(self, mock_trigger, admin_client, test_lead, org_a):
        response = admin_client.post(
            f"/api/leads/{test_lead.id}/trigger-call/",
            format="json"
        )
        assert response.status_code == 200
        assert "simulated in sandbox mode" in response.json()["message"]
        mock_trigger.assert_called_once_with(str(test_lead.id), str(org_a.id))

