# Logbooks Web App

A professional web application for managing and filling out logbooks, with role-based access for administrators and staff. Built with modern web technologies and Firebase for backend services.

## Features

### Admin Panel
- **Template Management**: Create, edit, rename, and delete logbook templates
- **Store Management**: Add and manage store locations
- **Template Assignment**: Assign templates to stores for daily logbook generation
- **Builder Tool**: Drag-and-drop interface to build logbook templates with headings, tables, and form fields
- **PDF Export**: Fill templates and export professional PDF documents

### Staff Panel
- **Daily Logbooks**: View and fill assigned logbooks for the current day
- **Form Filling**: Interactive forms with temperature inputs, yes/no fields, signatures, and notes
- **PDF Generation**: Export completed logbooks as PDF files
- **Store Selection**: Choose store location to view relevant logbooks

## Technologies Used

- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **Backend**: Firebase Firestore
- **PDF Generation**: html2pdf.js
- **Styling**: Custom CSS with professional light theme
- **Icons**: Unicode emojis for UI elements

## Project Structure

```
finaltest/
├── index.html              # Main landing page with role selection
├── shared/
│   └── styles.css          # Shared CSS styles
├── admin/
│   ├── index.html          # Admin dashboard
│   ├── templates.html      # Template and store management
│   ├── builder.html        # Template builder interface
│   └── fill.html           # Admin template filling and PDF export
└── user/
    ├── index.html          # Staff dashboard
    ├── today.html          # Daily logbooks view
    └── fill.html           # Staff logbook filling and PDF export
```

## Setup Instructions

### Prerequisites
- A Firebase project with Firestore enabled
- A web browser (Chrome, Firefox, Safari, Edge)
- Local web server (optional, for better development experience)

### Firebase Configuration

1. Create a new Firebase project at [https://console.firebase.google.com/](https://console.firebase.google.com/)
2. Enable Firestore Database
3. Set up Firestore security rules (allow read/write for authenticated users or adjust as needed)
4. Get your Firebase configuration from Project Settings

### Installation

1. Clone or download this repository
2. Open the project folder
3. Update Firebase configuration in all JavaScript files:
   - `admin/templates.html`
   - `admin/fill.html`
   - `admin/builder.html`
   - `user/today.html`
   - `user/fill.html`

   ```javascript
   const firebaseConfig = {
     apiKey: "AIzaSyD--9gIymq-tT-o9CGp32W7GFtgXuGQeJw",
     authDomain: "dradanddrop-bb7c5.firebaseapp.com",
     projectId: "dradanddrop-bb7c5",
     storageBucket: "dradanddrop-bb7c5.firebasestorage.app",
     messagingSenderId: "907742522220",
     appId: "1:907742522220:web:4fd124ca048626c9e1e149",
     measurementId: "G-W83330W3GJ"
   };
   ```

### Running the Application

#### Option 1: Direct File Opening
- Open `index.html` in your web browser
- Note: Some features may not work due to CORS restrictions when opening HTML files directly

#### Option 2: Local Web Server (Recommended)
- Use a local web server like:
  - Python: `python -m http.server 8000`
  - Node.js: `npx http-server`
  - VS Code Live Server extension
- Navigate to `http://localhost:8000` (or appropriate port)

## Usage

### For Administrators
1. Start at the main page and select "Admin"
2. Create logbook templates using the Builder tool
3. Add stores and assign templates to them
4. Test templates by filling them out and exporting PDFs

### For Staff
1. Start at the main page and select "Staff"
2. Choose your store location
3. View today's assigned logbooks
4. Fill out forms and export completed logbooks as PDFs

## Key Components

### Template Builder
- Drag and drop interface for creating logbook layouts
- Support for headings, tables, form fields, and signatures
- Real-time preview of template structure

### Form Fields
- **Temperature**: Numeric input with °C units
- **Yes/No**: Checkbox-style selections
- **Notes**: Text areas for additional information
- **Signatures**: Signature lines for authorization

### PDF Export
- Generates professional PDF documents
- Maintains Word-style formatting
- Downloads directly to browser's Downloads folder

## Browser Compatibility

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## Security Notes

- This application uses Firebase Firestore for data storage
- Ensure proper Firestore security rules are configured for production use
- Consider implementing user authentication for production deployments