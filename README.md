# qj_lambda

A Node.js backend project handling authentication, image uploads, YouTube integrations, and other route handlers for a web application. The project includes support for Google OAuth, S3 file uploads, database access, and email functionality.

## Features

- ✅ Google and YouTube OAuth authentication
- ✅ AWS S3 integration for avatar/image uploads
- ✅ YouTube API integration
- ✅ Email utilities
- ✅ Modular route handlers for posts, profiles, game plans, and more
- ✅ GitHub Actions for deployment workflow

## Getting Started

### Prerequisites

- Node.js v18+
- npm
- Environment variables set up (`.env` file or system config):
  - AWS credentials
  - Google/YouTube OAuth secrets
  - Database connection URI
  - Email SMTP config

### Installation

```bash
git clone https://github.com/kuanting-wu/qj_lambda.git
cd qj_lambda
npm install
```

### Running the Server

```bash
node index.js
```

## Project Structure

```
qj_lambda/
├── .github/workflows/       # GitHub Actions CI/CD
├── auth-handlers.js         # Auth route handlers
├── auth.js                  # Auth logic (JWT, OAuth, etc.)
├── db.js                    # Database connection and queries
├── email.js                 # Email sending logic
├── game-plan-handlers.js    # Game plan route logic
├── google-auth.js           # Google login integration
├── handle_upload_avatar.js  # Avatar upload via S3
├── image-handlers.js        # Image-related route handlers
├── index.js                 # Server entry point
├── package.json             # Dependencies and scripts
├── post-handlers.js         # Post route handlers
├── profiles-handlers.js     # Profile route handlers
├── s3-avatar-helper.js      # Helper for avatar upload
├── s3-helper.js             # Generic S3 helper functions
├── youtube-auth.js          # YouTube OAuth logic
└── youtube-handlers.js      # YouTube route handlers
```
