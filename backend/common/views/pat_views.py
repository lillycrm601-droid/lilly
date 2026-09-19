"""Personal Access Token CRUD for the LillyCRM MCP server.

A user manages ONLY their own tokens. Both list and revoke are filtered by
``org=request.profile.org`` AND ``profile=request.profile`` so another user's
token id 404s rather than leaking or being revoked (IDOR guard). The raw token
is returned exactly once, on create; ``token_hash`` is never serialized.
"""

from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from common.models import PersonalAccessToken
from common.permissions import HasOrgContext
from common.serializer import (
    PersonalAccessTokenCreateSerializer,
    PersonalAccessTokenListSerializer,
)


class PersonalAccessTokenListCreateView(APIView):
    permission_classes = (IsAuthenticated, HasOrgContext)

    @extend_schema(tags=["MCP / Tokens"], operation_id="pat_list")
    def get(self, request):
        qs = PersonalAccessToken.objects.filter(
            org=request.profile.org, profile=request.profile
        ).order_by("-created_at")
        return Response(
            {
                "error": False,
                "tokens": PersonalAccessTokenListSerializer(qs, many=True).data,
            },
            status=status.HTTP_200_OK,
        )

    @extend_schema(
        tags=["MCP / Tokens"],
        operation_id="pat_create",
        request=PersonalAccessTokenCreateSerializer,
    )
    def post(self, request):
        ser = PersonalAccessTokenCreateSerializer(data=request.data)
        if not ser.is_valid():
            return Response(
                {"error": True, "errors": ser.errors},
                status=status.HTTP_400_BAD_REQUEST,
            )
        raw, pat = PersonalAccessToken.generate(
            profile=request.profile,
            name=ser.validated_data["name"],
            scopes=ser.validated_data.get("scopes", []),
            expires_at=ser.validated_data.get("expires_at"),
        )
        data = PersonalAccessTokenListSerializer(pat).data
        data["token"] = raw  # shown ONCE, never retrievable again
        return Response({"error": False, **data}, status=status.HTTP_201_CREATED)


class PersonalAccessTokenDetailView(APIView):
    permission_classes = (IsAuthenticated, HasOrgContext)

    @extend_schema(tags=["MCP / Tokens"], operation_id="pat_revoke")
    def delete(self, request, pk):
        pat = get_object_or_404(
            PersonalAccessToken,
            pk=pk,
            org=request.profile.org,
            profile=request.profile,
        )
        if pat.revoked_at is None:
            pat.revoked_at = timezone.now()
            pat.save(update_fields=["revoked_at"])
        return Response({"error": False}, status=status.HTTP_200_OK)
