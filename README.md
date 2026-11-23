
# FixMate — Device & Home Appliance Repair Platform

FixMate is a web-based repair service platform that connects customers with technicians who provide repair services for smartphones, laptops and PCs, air conditioners, refrigerators, televisions, washing machines, and other electrical devices.

Customers can explore available repair services, submit repair requests, follow their booking progress, and pay after a repair has been completed. Technicians can publish and manage their services and handle incoming repair requests. Administrators oversee users, service approvals, bookings, and transactions.

## Project Links

- **Live application:** https://fixmate-client-murex.vercel.app
- **Frontend repository:** https://github.com/md-tanjim/FixMate-client
- **Backend repository:** https://github.com/md-tanjim/FixMate-server

## Project Overview

FixMate follows a pay-after-service workflow. A customer chooses an available service and submits a repair request. The assigned technician handles the job and, when the repair is complete, specifies the final amount. The customer can then complete the payment through Stripe Checkout.

The application has three account roles: **Customer**, **Technician**, and **Admin**. Each role has its own dashboard and available actions.

## Key Features

### Customer

- Browse available repair services and view service and technician details.
- Search services and filter by category and service mode; sort by price or newest listing.
- Submit a repair request with contact details, address, preferred date, and a description of the problem.
- View booking details and track the booking status.
- Cancel a booking while it is still in the requested state.
- Pay for a completed repair through Stripe Checkout.
- Review payment history, copy transaction IDs, and download PDF payment receipts.
- Update profile information.

### Technician

- Create repair service listings with descriptions, categories, pricing, estimated duration, service mode, service area, and an image.
- View and manage personal service listings, including editing, deleting, and changing availability.
- Review incoming customer repair requests.
- Accept or reject requests, start accepted jobs, and mark repairs as completed with a final amount.
- View service and request information from the technician dashboard.

### Admin

- View platform statistics, booking activity, and revenue analytics.
- Manage users and update account roles.
- Review submitted service listings and approve or reject them.
- Monitor all bookings and payment transactions.

### Repair and Payment Workflow

1. A customer browses an approved, available service and opens its details page.
2. The customer submits a repair request.
3. The technician accepts or rejects the request. An accepted job can move to in progress.
4. When the repair is finished, the technician marks the job completed and provides the final amount.
5. The customer pays the final amount using Stripe Checkout.
6. The payment success page asks the backend to verify the Checkout Session and displays the confirmed payment details.

Booking states used by the application include `requested`, `accepted`, `in-progress`, `completed`, `rejected`, and `cancelled`. Payment states include `unpaid` and `paid`.

## Technology Stack

| Area | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| UI library | React 19 |
| Language | TypeScript |
| Styling | Tailwind CSS 4, shadcn/ui, Base UI |
| Authentication | Better Auth with MongoDB adapter, admin and JWT plugins |
| Database connectivity | MongoDB Node.js driver (used by the Better Auth configuration) |
| Backend communication | Fetch API with the Express backend |
| Payments | Stripe Checkout integration |
| Image hosting | ImgBB through a Next.js upload route |
| Charts | Recharts |
| PDF receipts | jsPDF |
| Notifications | React Toastify |
| Icons | Lucide React and React Icons |
| Theme support | next-themes |

### Installed Packages

The following direct dependencies are declared in `package.json`.

**Application dependencies:**

- `next`, `react`, `react-dom`
- `better-auth`, `@better-auth/mongo-adapter`, `mongodb`
- `@stripe/stripe-js`, `stripe`
- `tw-animate-css`
- `shadcn`, `@base-ui/react`, `class-variance-authority`, `cn`
- `lucide-react`, `react-icons`, `next-themes`
- `recharts`, `jspdf`, `react-toastify`

**Development and formatting tools:**

- `typescript`, `tailwindcss`, `@tailwindcss/postcss`
- `eslint`, `eslint-config-next`
- `prettier`, `prettier-plugin-tailwindcss`
- `@types/node`, `@types/react`, `@types/react-dom`



## Authentication and Authorization

- Better Auth handles email/password authentication and is configured with Google as a social provider.
- The user model has additional profile fields for phone, area, and bio. Public registration offers customer and technician roles; administrative access is managed separately.
- The Better Auth JWT plugin provides tokens used when the frontend calls protected Express API endpoints.
- The dashboard proxy checks the signed-in user's role and redirects attempts to open another role's dashboard to the user's own dashboard.
- The shared dashboard layout provides role-specific navigation, account information, theme switching, and sign-out controls.

## Backend API Integration

The frontend reads the Express API base URL from `NEXT_PUBLIC_API_URL`. API access functions are organized in `lib/api/` by public, customer, technician, and admin functionality.

The frontend communicates with backend endpoints for:

- Public featured services, service details, and filtered service listings.
- Customer bookings, booking counts, booking cancellation, and payment history.
- Technician service creation and management, service availability, repair requests, and booking status updates.
- Admin overview analytics, user management, service approvals, all bookings, and transactions.
- Stripe Checkout Session creation and payment verification.

## Payment Integration

The customer starts checkout from an eligible completed booking. The frontend sends the booking ID to the protected checkout endpoint and redirects the customer to the Stripe Checkout URL returned by the backend.

After checkout, `/payment/success` reads the `session_id` query parameter and calls the protected backend verification endpoint. The page displays the confirmed amount, technician and service information, and transaction ID. `/payment/cancel` provides a return path to the customer's bookings without presenting the payment as completed.

## Image Uploads and PDF Receipts

- Profile and service images are uploaded through the Next.js route at `/api/upload/profile-image`, which forwards the image to ImgBB and returns its URL. The upload route validates image type and file size.
- Customer payment history uses jsPDF to generate downloadable payment receipts. Transaction IDs can also be copied from the page.

## Getting Started

### Prerequisites

- Node.js and npm.
- Access to a running FixMate Express backend and its configured database.
- A MongoDB connection string for the Better Auth configuration.
- ImgBB credentials for image uploads.
- Google OAuth credentials if Google sign-in is enabled in the environment.
- Stripe configured on the backend for checkout and payment verification.

### 1. Clone the Frontend Repository

```bash
git clone https://github.com/md-tanjim/FixMate-client.git
cd FixMate-client
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a `.env.local` file in the project root. The following names are read by the current frontend source; replace the example values with your own environment-specific values.

```env
# Express backend base URL
NEXT_PUBLIC_API_URL=http://localhost:5000

# Better Auth server configuration
BETTER_AUTH_URL=http://localhost:3000
MONGO_DB_URL=<your-mongodb-connection-string>

# Google OAuth (when enabled)
GOOGLE_CLIENT_ID=<your-google-client-id>
GOOGLE_CLIENT_SECRET=<your-google-client-secret>

# ImgBB upload route
NEXT_PUBLIC_IMG_BB_API_KEY=<your-imgbb-api-key>
IMG_BB_URL=<your-imgbb-upload-endpoint>
```

Do not commit `.env.local`, real API keys, database credentials, OAuth secrets, or payment secrets to Git. Configure the corresponding environment variables in the deployment environment as well. The Express backend has its own environment configuration; frontend variables do not replace backend configuration.

### 4. Start the Development Server

Make sure the Express backend is running and `NEXT_PUBLIC_API_URL` points to it, then run:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the Next.js development server |
| `npm run build` | Create a production build |
| `npm run start` | Start the production server after building |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run the TypeScript compiler without emitting files |
| `npm run format` | Format TypeScript and TSX files with Prettier |


## Notes

- This repository contains the **Express.js backend**. The Next.js frontend is maintained separately and must be available for API-driven features to work.
