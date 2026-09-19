from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from common.models import APISettings, Attachments, Comment
from common.permissions import HasOrgContext
from common.serializer import LeadCommentSerializer
from contacts.models import Contact
from leads import swagger_params
from leads.forms import LeadListForm
from leads.models import Lead
from leads.serializer import (
    CreateLeadFromSiteSwaggerSerializer,
    LeadCommentEditSwaggerSerializer,
    LeadUploadSwaggerSerializer,
)
from leads.tasks import create_lead_from_file, send_lead_assigned_emails


class LeadUploadView(APIView):
    model = Lead
    permission_classes = (IsAuthenticated, HasOrgContext)

    @extend_schema(
        tags=["Leads"],
        parameters=swagger_params.organization_params,
        request=LeadUploadSwaggerSerializer,
        responses={
            200: inline_serializer(
                name="LeadUploadResponse",
                fields={
                    "error": serializers.BooleanField(),
                    "message": serializers.CharField(),
                },
            )
        },
    )
    def post(self, request, *args, **kwargs):
        lead_form = LeadListForm(request.POST, request.FILES)
        if lead_form.is_valid():
            create_lead_from_file.delay(
                lead_form.validated_rows,
                lead_form.invalid_rows,
                request.profile.id,
                request.get_host(),
                request.profile.org.id,
            )
            return Response(
                {"error": False, "message": "Leads created Successfully"},
                status=status.HTTP_200_OK,
            )
        return Response(
            {"error": True, "errors": lead_form.errors},
            status=status.HTTP_400_BAD_REQUEST,
        )


class LeadCommentView(APIView):
    model = Comment
    permission_classes = (IsAuthenticated, HasOrgContext)

    def get_object(self, pk):
        return self.model.objects.get(pk=pk, org=self.request.profile.org)

    @extend_schema(
        tags=["Leads"],
        parameters=swagger_params.organization_params,
        request=LeadCommentEditSwaggerSerializer,
        responses={
            200: inline_serializer(
                name="LeadCommentUpdateResponse",
                fields={
                    "error": serializers.BooleanField(),
                    "message": serializers.CharField(),
                },
            )
        },
    )
    def put(self, request, pk, format=None):
        params = request.data
        obj = self.get_object(pk)
        if (
            request.profile.role == "ADMIN"
            or request.user.is_superuser
            or request.profile == obj.commented_by
        ):
            serializer = LeadCommentSerializer(obj, data=params)
            if serializer.is_valid():
                serializer.save()
                return Response(
                    {"error": False, "message": "Comment Submitted"},
                    status=status.HTTP_200_OK,
                )
            return Response(
                {"error": True, "errors": serializer.errors},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            {
                "error": True,
                "errors": "You don't have permission to perform this action",
            },
            status=status.HTTP_403_FORBIDDEN,
        )

    @extend_schema(
        tags=["Leads"],
        parameters=swagger_params.organization_params,
        request=LeadCommentEditSwaggerSerializer,
        description="Partial Comment Update",
        responses={
            200: inline_serializer(
                name="LeadCommentPatchResponse",
                fields={
                    "error": serializers.BooleanField(),
                    "message": serializers.CharField(),
                },
            )
        },
    )
    def patch(self, request, pk, format=None):
        """Handle partial updates to a comment."""
        params = request.data
        obj = self.get_object(pk)
        if (
            request.profile.role == "ADMIN"
            or request.user.is_superuser
            or request.profile == obj.commented_by
        ):
            serializer = LeadCommentSerializer(obj, data=params, partial=True)
            if serializer.is_valid():
                serializer.save()
                return Response(
                    {"error": False, "message": "Comment Updated"},
                    status=status.HTTP_200_OK,
                )
            return Response(
                {"error": True, "errors": serializer.errors},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            {
                "error": True,
                "errors": "You don't have permission to perform this action",
            },
            status=status.HTTP_403_FORBIDDEN,
        )

    @extend_schema(
        tags=["Leads"],
        parameters=swagger_params.organization_params,
        responses={
            200: inline_serializer(
                name="LeadCommentDeleteResponse",
                fields={
                    "error": serializers.BooleanField(),
                    "message": serializers.CharField(),
                },
            )
        },
    )
    def delete(self, request, pk, format=None):
        self.object = self.get_object(pk)
        if (
            request.profile.role == "ADMIN"
            or request.user.is_superuser
            or request.profile == self.object.commented_by
        ):
            self.object.delete()
            return Response(
                {"error": False, "message": "Comment Deleted Successfully"},
                status=status.HTTP_200_OK,
            )

        return Response(
            {
                "error": True,
                "errors": "You do not have permission to perform this action",
            },
            status=status.HTTP_403_FORBIDDEN,
        )


class LeadAttachmentView(APIView):
    model = Attachments
    permission_classes = (IsAuthenticated, HasOrgContext)

    @extend_schema(
        tags=["Leads"],
        parameters=swagger_params.organization_params,
        responses={
            200: inline_serializer(
                name="LeadAttachmentDeleteResponse",
                fields={
                    "error": serializers.BooleanField(),
                    "message": serializers.CharField(),
                },
            )
        },
    )
    def delete(self, request, pk, format=None):
        self.object = self.model.objects.get(pk=pk)
        if (
            request.profile.role == "ADMIN"
            or request.user.is_superuser
            or request.profile.user == self.object.created_by
        ):
            self.object.delete()
            return Response(
                {"error": False, "message": "Attachment Deleted Successfully"},
                status=status.HTTP_200_OK,
            )
        return Response(
            {
                "error": True,
                "errors": "You don't have permission to perform this action",
            },
            status=status.HTTP_403_FORBIDDEN,
        )


class CreateLeadFromSite(APIView):
    @extend_schema(
        tags=["Leads"],
        parameters=swagger_params.organization_params,
        request=CreateLeadFromSiteSwaggerSerializer,
        responses={
            200: inline_serializer(
                name="CreateLeadFromSiteResponse",
                fields={
                    "error": serializers.BooleanField(),
                    "message": serializers.CharField(),
                },
            )
        },
    )
    def post(self, request, *args, **kwargs):
        params = request.data
        api_key = params.get("apikey")
        # api_setting = APISettings.objects.filter(
        #     website=website_address, apikey=api_key).first()
        api_setting = APISettings.objects.filter(apikey=api_key).first()
        if not api_setting:
            return Response(
                {
                    "error": True,
                    "message": "You don't have permission, please contact the admin!.",
                },
                status=status.HTTP_403_FORBIDDEN,
            )

        if api_setting and params.get("email"):
            user = api_setting.created_by
            from common.models import Profile
            profile = Profile.objects.filter(user=user, org=api_setting.org, is_active=True).first()
            email_val = params.get("email")

            # Check if lead already exists in this organization to prevent unique constraint violation
            existing_lead = Lead.objects.filter(email__iexact=email_val, org=api_setting.org).first()
            if existing_lead:
                existing_lead.description = params.get("message") or existing_lead.description
                existing_lead.phone = params.get("phone") or existing_lead.phone
                existing_lead.save()

                # Trigger Bolna call on existing lead
                from leads.tasks import trigger_bolna_call
                trigger_bolna_call.delay(existing_lead.id, str(api_setting.org.id))

                return Response(
                    {
                        "error": False,
                        "message": "Lead Updated successfully.",
                        "lead_id": str(existing_lead.id)
                    },
                    status=status.HTTP_200_OK,
                )

            # Create new lead
            lead = Lead.objects.create(
                salutation=params.get(
                    "title"
                ),  # 'title' param maps to salutation for backwards compatibility
                first_name=params.get("first_name"),
                last_name=params.get("last_name"),
                status="assigned",
                source=api_setting.website,
                description=params.get("message"),
                email=email_val,
                phone=params.get("phone"),
                is_active=True,
                created_by=user,
                org=api_setting.org,
            )
            if profile:
                lead.assigned_to.add(profile)

            # Send Email to Assigned Users (requires profile IDs)
            if profile:
                site_address = request.scheme + "://" + request.META["HTTP_HOST"]
                send_lead_assigned_emails.delay(
                    lead.id, [profile.id], site_address, str(api_setting.org.id)
                )

            # Create or update Contact
            try:
                existing_contact = Contact.objects.filter(email__iexact=email_val, org=api_setting.org).first()
                if existing_contact:
                    contact = existing_contact
                    contact.phone = params.get("phone") or contact.phone
                    contact.description = params.get("message") or contact.description
                    contact.save()
                else:
                    contact = Contact.objects.create(
                        first_name=params.get("first_name") or "",
                        last_name=params.get("last_name") or "",
                        email=email_val,
                        phone=params.get("phone"),
                        description=params.get("message"),
                        created_by=user,
                        is_active=True,
                        org=api_setting.org,
                    )
                    if profile:
                        contact.assigned_to.add(profile)

                lead.contacts.add(contact)
            except Exception:
                pass

            return Response(
                {
                    "error": False,
                    "message": "Lead Created sucessfully.",
                    "lead_id": str(lead.id)
                },
                status=status.HTTP_200_OK,
            )
        return Response(
            {"error": True, "message": "Invalid data"},
            status=status.HTTP_400_BAD_REQUEST,
        )


class TriggerLeadCallView(APIView):
    permission_classes = (IsAuthenticated, HasOrgContext)

    def post(self, request, pk, *args, **kwargs):
        from django.conf import settings
        from leads.tasks import trigger_bolna_call

        api_key = getattr(settings, "BOLNA_API_KEY", "")
        agent_id = getattr(settings, "BOLNA_AGENT_ID", "")
        is_simulation = not api_key or not agent_id

        # Trigger the Celery task
        trigger_bolna_call.delay(pk, str(request.profile.org.id))

        message = (
            "Bolna AI call simulated in sandbox mode (unconfigured keys)."
            if is_simulation
            else "Bolna AI call triggered successfully."
        )

        return Response(
            {"error": False, "message": message},
            status=status.HTTP_200_OK,
        )

