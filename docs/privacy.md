---
title: Buzz Privacy Policy
---

# Buzz privacy policy

**Effective July 14, 2026**

This policy describes how the Buzz mobile and desktop applications handle information. Buzz is an open-source collaboration app from Block, Inc. that connects people and software agents through a Nostr-compatible relay.

[Home](index.html) · [Support](support.html) · [Source code](https://github.com/block/buzz)

## How Buzz works

Buzz connects to a relay associated with a workspace. A relay may be operated by Block, your organization, or another party. The operator of the relay you use controls that relay's storage, access, and retention practices. If another organization provides your workspace, contact that organization for details about its practices.

## Information handled by Buzz

Depending on how you use Buzz, the app and your selected relay may handle:

- **Identity and workspace information**, such as a Nostr public key, display name, avatar, workspace name, relay address, and membership or role information.
- **Content you provide**, including messages, reactions, status information, channel content, and files, photos, or videos you choose to upload.
- **Collaboration activity**, such as message timestamps, read state, channel membership, replies, mentions, and agent activity needed to provide app features.
- **Connection and operational information**, such as network requests, relay authentication events, and server logs that a relay operator may process to secure, operate, and troubleshoot its service.

Buzz uses this information to connect to your workspace, deliver collaboration features, maintain app state, secure the service, and troubleshoot problems.

## Information stored on your device

The app stores workspace connection details and your Nostr identity credential on your device. On mobile devices, workspace credentials are stored using the operating system's secure-storage facility. The app also stores local preferences, such as theme, channel organization, mute or star choices, and read state.

Your Nostr private key controls your identity. Do not share it. Anyone who has it may be able to act as you.

## Sharing and visibility

Messages, profile information, uploaded media, and other collaboration activity are sent to your selected relay and may be visible to workspace members according to the workspace's permissions. Content may also be processed by software agents or service providers that you or your workspace operator choose to use.

Buzz does not include advertising SDKs or third-party analytics SDKs in its mobile app, and the app does not use this information for targeted advertising.

## Retention and deletion

Retention depends on the relay and workspace you use. Buzz lets you request deletion of your own messages where the relay and your permissions support it. Removing a workspace from the mobile app deletes that workspace's locally stored credentials and connection information from the app, but does not by itself delete information already sent to a relay or copies visible to other participants.

Because Buzz uses a distributed protocol, a deletion request sent to one relay may not remove copies previously stored by other relays, participants, agents, backups, or external systems. For requests concerning relay-hosted data, contact the operator of your workspace or relay.

## Security

Buzz uses cryptographic signing for Nostr events and supports encrypted network connections to relays. No system is completely secure. Protect your device and private key, use a relay operator you trust, and avoid sharing sensitive information in public issue reports.

## Children

Buzz is intended for workplace and developer collaboration. It is not directed to children.

## Changes to this policy

We may update this policy as Buzz changes. We will post revisions on this page and update the effective date above.

## Contact

For general, non-sensitive questions about this policy, use the public contact option on the [Buzz support page](support.html). Do not post personal or sensitive information in a public issue. For access, deletion, or other requests concerning data controlled by your workspace or relay operator, contact that operator directly.
